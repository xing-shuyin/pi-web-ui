import { resolveEnabledAgentTools } from "./tool-manager.js";

export const PRESET_EXCLUDED_KEYS = [
	"_promptPluginDevConfigured",
	"nativeCliInheritModel",
	"quickAskEnabled",
	"quickAskModel",
	"quickAskThinking",
	"quickAskSystemPrompt",
	"quickAskExplainPrompt",
	"quickAskTranslateEnabled",
	"quickAskTranslateTarget",
	"quickAskTranslateStyle",
	"quickAskTranslatePrompt",
	"quickAskShowOriginal",
	"quickAskReferenceMenus",
	"quickAskConversationScope",
	"quickAskFolderScope",
] as const;
export type PresetExcludedKey = (typeof PRESET_EXCLUDED_KEYS)[number];

export const PRESET_GROUP_ORDER = ["prompt", "tools", "terminal", "skills", "ai", "ui", "engine"] as const;
export type PresetFieldGroup = (typeof PRESET_GROUP_ORDER)[number];

export const PRESET_FIELD_GROUPS = {
	prompt: [
		"promptMode",
		"customSystemPrompt",
		"promptTemplate",
		"promptOverrides",
		"promptDisabled",
		"reviewPrompt",
		"reviewDisabledSkills",
	],
	tools: [
		"disabledAgentTools",
		"disabledPluginTools",
		"toolPromptOverrides",
		"toolLazyLoading",
		"codemodeMode",
		"codemodeInlineBudget",
		"readDirEnabled",
		"toolApprovalEnabled",
		"toolWatchdogTimeoutMs",
		"questionnaireEnabled",
		"questionPresentation",
		"toolApprovalPresentation",
		"questionTimeoutSeconds",
		"editSoftEnabled",
		"terminalToolsEnabled",
	],
	terminal: ["terminalBash", "terminalBashIdleMs", "terminalBashMaxForegroundMs"],
	skills: [
		"disabledSkills",
		"disabledExtensions",
		"skillsFullText",
		"skillsCatalogMaxDesc",
		"skillsCatalogShowLocation",
		"skillsCatalogBudget",
		"skillsMaxFileBytes",
		"skillsFullTextMaxBytes",
	],
	ai: [
		"steeringMode",
		"followUpMode",
		"retryMaxAttempts",
		"softCapTokens",
		"softCapByModel",
		"autoCompactionInstructions",
		"subagentDefaultModel",
		"subagentMaxDepth",
		"subagentAutoWakeMaxTurns",
		"visionBridgeEnabled",
		"visionBridgeModel",
		"visionBridgePromptMode",
		"visionBridgePrompt",
		"scmCommitMsgPromptMode",
		"scmCommitMsgPrompt",
		"planModePromptMode",
		"planModePrompt",
		"goalModeEnabled",
		"parallelReminderEnabled",
	],
	ui: [
		"uiLayout",
		"disabledPlugins",
		"thinkingWrap",
		"toolsWrap",
		"toolImagesEnabled",
		"keepRecentMessages",
		"reversePagination",
		"showForkedParentSessions",
		"retainFinishedConversations",
		"openRecentSessionOnProjectSwitch",
		"chatUploadMaxMb",
		"workspaceUploadMaxMb",
		"folderUploadMaxMb",
		"bgAutoCleanupMin",
		"quickPhrases",
		"quickPhrasesEnabled",
		"minimalNewChat",
		"preserveDraftAcrossConversations",
		"devNoCache",
		"autoReload",
	],
	engine: ["defaultAgentPreset", "defaultPermissionPreset"],
} as const;

export type PresetFieldName = (typeof PRESET_FIELD_GROUPS)[PresetFieldGroup][number];

export const PRESET_FIELD_NAMES: readonly PresetFieldName[] = (() => {
	const out: PresetFieldName[] = [];
	for (const g of PRESET_GROUP_ORDER) for (const f of PRESET_FIELD_GROUPS[g]) if (!out.includes(f)) out.push(f);
	return out;
})();

export function presetFieldGroup(field: string): PresetFieldGroup | undefined {
	for (const g of PRESET_GROUP_ORDER) {
		if ((PRESET_FIELD_GROUPS[g] as readonly string[]).includes(field)) return g;
	}
	return undefined;
}

export function groupPresetFields(fields: readonly string[]): { group: PresetFieldGroup; fields: string[] }[] {
	const set = new Set(fields);
	const out: { group: PresetFieldGroup; fields: string[] }[] = [];
	for (const g of PRESET_GROUP_ORDER) {
		const hit = PRESET_FIELD_GROUPS[g].filter((f) => set.has(f));
		if (hit.length > 0) out.push({ group: g, fields: hit });
	}
	return out;
}

export function normalizePresetFieldSelection(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const wanted = new Set(v.filter((x): x is string => typeof x === "string"));
	return PRESET_FIELD_NAMES.filter((f) => wanted.has(f));
}

export interface PresetFieldInfo {
	labelZh: string;
	labelEn: string;
	hintZh?: string;
	hintEn?: string;
}

export const PRESET_FIELD_META = {
	promptMode: {
		labelZh: "提示词模式",
		labelEn: "Prompt Mode",
		hintZh: "追加到内置提示词 (append) 或完全替换系统内置提示词 (replace)",
		hintEn: "Append to built-in prompt or completely replace it",
	},
	customSystemPrompt: {
		labelZh: "自定义系统提示词",
		labelEn: "Custom System Prompt",
		hintZh: "定制 AI 基础人设与工作规约的主提示词",
		hintEn: "Main prompt customizing AI persona and instructions",
	},
	promptTemplate: {
		labelZh: "组合模板",
		labelEn: "Prompt Template",
		hintZh: "高级提示词组装模板（包含各个 slot 占位符）",
		hintEn: "Advanced prompt composition template with slot placeholders",
	},
	promptOverrides: {
		labelZh: "逐段提示词覆盖",
		labelEn: "Sectional Prompt Overrides",
		hintZh: "微调特定提示词段落（如 soul/cwd/skills 等）",
		hintEn: "Overrides for specific prompt sections (soul, cwd, skills, etc.)",
	},
	reviewPrompt: {
		labelZh: "目标模式审查提示词",
		labelEn: "Goal Mode Review Prompt",
		hintZh: "目标模式 2.0 中审查者专用的判定与指导提示词",
		hintEn: "Prompt for the reviewer in Goal Mode 2.0",
	},
	reviewDisabledSkills: {
		labelZh: "审查时禁用的技能",
		labelEn: "Skills Disabled in Review",
		hintZh: "仅在目标审查阶段禁止审查者调用的技能列表",
		hintEn: "Skills unavailable to the reviewer in Goal Mode",
	},
	promptDisabled: {
		labelZh: "禁用的提示词段",
		labelEn: "Disabled Prompt Sections",
		hintZh: "组合模板中不渲染的提示词段（如 soul/skills）",
		hintEn: "Prompt sections excluded from the composed template",
	},
	disabledAgentTools: {
		labelZh: "禁用的内置工具",
		labelEn: "Disabled Agent Tools",
		hintZh: "不在 AI 可用工具列表中暴露的内置工具",
		hintEn: "Built-in tools removed from agent visibility",
	},
	disabledPluginTools: {
		labelZh: "禁用的插件工具",
		labelEn: "Disabled Plugin Tools",
		hintZh: "禁止向 AI 注册的第三方插件工具",
		hintEn: "Plugin-provided tools removed from agent visibility",
	},
	toolPromptOverrides: {
		labelZh: "工具提示词覆盖",
		labelEn: "Tool Prompt Overrides",
		hintZh: "微调工具在模型视野中的描述、触发条件与使用指南",
		hintEn: "Custom descriptions, snippets and guidelines for tools",
	},
	toolLazyLoading: {
		labelZh: "工具按需延迟加载",
		labelEn: "Tool Lazy Loading",
		hintZh: "仅常驻核心工具，其余工具通过 load_tools 按需动态引入（节省上下文）",
		hintEn: "Keep only core tools active; load others on demand (saves context)",
	},
	codemodeMode: {
		labelZh: "codemode 运行模式",
		labelEn: "Codemode Execution Mode",
		hintZh: "常规模式（on）或纯代码模式（only，仅通过沙箱脚本调用工具）",
		hintEn: "Regular mode (on) or strict code mode (only, all tool calls run via sandbox script)",
	},
	codemodeInlineBudget: {
		labelZh: "codemode 工具声明预算",
		labelEn: "Codemode Inline Budget",
		hintZh: "直接嵌入在 codemode 系统提示词中的工具声明 Token 预算（默认 3000）",
		hintEn: "Token budget for tool declarations directly embedded in the codemode prompt (default: 3000)",
	},
	readDirEnabled: {
		labelZh: "read 工具列目录",
		labelEn: "Directory Listing in read",
		hintZh: "允许 read 工具在路径为目录时直接返回文件列表",
		hintEn: "Allow read tool to list directory entries when target is a folder",
	},
	toolApprovalEnabled: {
		labelZh: "工具执行审批门禁",
		labelEn: "Tool Execution Approval",
		hintZh: "执行危险或写操作工具前弹出用户确认确认框",
		hintEn: "Require user approval before executing tools",
	},
	chatUploadMaxMb: {
		labelZh: "聊天附件大小上限",
		labelEn: "Chat attachment size limit",
		hintZh: "单个文件大小，单位 MB（1–100）",
		hintEn: "Per-file limit in MB (1–100)",
	},
	workspaceUploadMaxMb: {
		labelZh: "文件面板上传大小上限",
		labelEn: "File panel upload size limit",
		hintZh: "单个文件大小，单位 MB（1–100）",
		hintEn: "Per-file limit in MB (1–100)",
	},
	folderUploadMaxMb: {
		labelZh: "文件夹上传大小上限",
		labelEn: "Folder upload size limit",
		hintZh: "每个文件的大小，单位 MB（1–100）",
		hintEn: "Per-file limit in MB (1–100)",
	},
	bgAutoCleanupMin: {
		labelZh: "后台任务自动清理",
		labelEn: "Background Task Auto-cleanup",
		hintZh: "定期清理闲置超阈值的 AI 起后台实例（分钟；0 = 关；面板里📌钉住的不算）",
		hintEn:
			"Periodically clean AI-started background instances idle past the threshold (minutes; 0 = off; pinned ones skipped)",
	},
	toolWatchdogTimeoutMs: {
		labelZh: "工具看门狗超时",
		labelEn: "Tool Watchdog Timeout",
		hintZh: "工具长时间未返回时的最长等待熔断时间",
		hintEn: "Maximum execution time before aborting stuck tools",
	},
	questionnaireEnabled: {
		labelZh: "问卷模式 (ask_user_question)",
		labelEn: "Questionnaire Mode",
		hintZh: "允许 AI 遇到歧义时弹窗向用户多选/单选确认",
		hintEn: "Allow agent to ask interactive multiple-choice questions",
	},
	questionPresentation: {
		labelZh: "问卷提醒方式",
		labelEn: "Questionnaire reminders",
		hintZh: "当前对话弹出、全部弹出或仅队列",
		hintEn: "Current conversation, all popups, or manual queue",
	},
	toolApprovalPresentation: {
		labelZh: "工具审批提醒方式",
		labelEn: "Tool approval reminders",
		hintZh: "当前对话弹出、全部弹出或仅队列",
		hintEn: "Current conversation, all popups, or manual queue",
	},
	questionTimeoutSeconds: {
		labelZh: "子代理问卷等待期限",
		labelEn: "Subagent question timeout",
		hintZh: "秒；0 为持续等待，超时不自动选择答案",
		hintEn: "Seconds; 0 waits indefinitely, timeout never selects an answer",
	},
	editSoftEnabled: {
		labelZh: "宽松缩进编辑 (edit_soft)",
		labelEn: "Soft Indentation Edit",
		hintZh: "提供忽略前导空白缩进差异的鲁棒编辑工具",
		hintEn: "Provide indentation-tolerant text replacement tool",
	},
	terminalToolsEnabled: {
		labelZh: "终端工具集",
		labelEn: "Terminal Toolset",
		hintZh: "向 AI 开放持久交互式 PTY 终端驱动工具",
		hintEn: "Enable persistent PTY interactive terminal tools",
	},
	terminalBash: {
		labelZh: "终端接管 Bash",
		labelEn: "Terminal Takes Over Bash",
		hintZh: "将 bash 工具调用分流至可见交互终端并实时回显",
		hintEn: "Route bash execution into the visible interactive terminal",
	},
	terminalBashIdleMs: {
		labelZh: "终端静默超时",
		labelEn: "Terminal Idle Timeout",
		hintZh: "终端无新输出时判定为完成的静默时间",
		hintEn: "Idle duration before assuming command finished",
	},
	terminalBashMaxForegroundMs: {
		labelZh: "前台最长运行时间",
		labelEn: "Max Foreground Runtime",
		hintZh: "前台命令超时未退出的强制截断时间",
		hintEn: "Timeout before cutting off long foreground commands",
	},
	disabledSkills: {
		labelZh: "禁用的技能",
		labelEn: "Disabled Skills",
		hintZh: "在当前工作区中禁用的技能列表",
		hintEn: "Skills excluded in the current workspace",
	},
	disabledExtensions: {
		labelZh: "禁用的扩展",
		labelEn: "Disabled Extensions",
		hintZh: "在当前项目中禁用的扩展列表",
		hintEn: "Extensions excluded in the current project",
	},
	skillsFullText: {
		labelZh: "技能全文常驻",
		labelEn: "Skills Full Text in Context",
		hintZh: "将指定技能的完整正文直接注入上下文，跳过 skill 工具按需载入",
		hintEn: "Inject full text of selected skills directly into context",
	},
	skillsCatalogMaxDesc: {
		labelZh: "技能描述截断字符数",
		labelEn: "Skill Description Cap",
		hintZh: "名录中单条技能描述最大字符数（默认 250，0 为不截断）",
		hintEn: "Max characters per skill description in catalog (default 250, 0 to disable)",
	},
	skillsCatalogShowLocation: {
		labelZh: "名录显示物理路径",
		labelEn: "Show Skill Location",
		hintZh: "是否在技能名录中输出 location 文件绝对路径（默认关，避免浪费 token 和泄露路径）",
		hintEn: "Whether to output file path in skill catalog (default off to save tokens and prevent path leak)",
	},
	skillsCatalogBudget: {
		labelZh: "技能名录总字符预算",
		labelEn: "Skill Catalog Budget",
		hintZh: "技能名录字符上限（默认 20000），超限自动降级为紧凑名称索引",
		hintEn: "Total catalog character limit (default 20000), falls back to compact name index when exceeded",
	},
	skillsMaxFileBytes: {
		labelZh: "技能单文件上限",
		labelEn: "Skill File Limit",
		hintZh: "单个技能正文上限（字节，默认 8192）；全文注入与 skill 工具同口径，0 表示不设单文件上限",
		hintEn:
			"Per-skill file size limit in bytes (default 8192), shared by full-text injection and the skill tool; 0 disables the per-file cap",
	},
	skillsFullTextMaxBytes: {
		labelZh: "技能全文注入预算",
		labelEn: "Skill Full-Text Budget",
		hintZh: "{{skills}} 全文注入的总字节预算（默认 32768，按 UTF-8 字节计），0 表示不设总量上限",
		hintEn:
			"Total byte budget for {{skills}} full-text injection (default 32768, counted in UTF-8 bytes); 0 disables the total cap",
	},
	steeringMode: {
		labelZh: "插话队列模式",
		labelEn: "Steering Queue Mode",
		hintZh: "一次处理全部插话或每次一条",
		hintEn: "Process all queued steering messages or one at a time",
	},
	followUpMode: {
		labelZh: "追问队列模式",
		labelEn: "Follow-Up Queue Mode",
		hintZh: "一次处理全部追问或每次一条",
		hintEn: "Process all queued follow-up messages or one at a time",
	},
	retryMaxAttempts: {
		labelZh: "网络重试上限",
		labelEn: "Network Retry Attempts",
		hintZh: "模型网络请求失败时的最大自动重试次数",
		hintEn: "Max auto-retries when model requests fail",
	},
	softCapTokens: {
		labelZh: "上下文压缩软上限",
		labelEn: "Context Soft-Cap Tokens",
		hintZh: "提前触发上下文平滑压缩的 token 阈值（默认 16384）",
		hintEn: "Token threshold to trigger context compaction early",
	},
	softCapByModel: {
		labelZh: "分模型压缩软上限",
		labelEn: "Per-Model Soft-Cap",
		hintZh: "针对不同模型单独设置的上下文压缩阈值",
		hintEn: "Custom soft-cap thresholds configured per model",
	},
	autoCompactionInstructions: {
		labelZh: "自动压缩附加指令",
		labelEn: "Auto-Compaction Instructions",
		hintZh: "软上限自动压缩时传给 SDK 的自定义指令（留空 = SDK 默认摘要；不影响手动 /compact）",
		hintEn:
			"Custom instructions passed to automatic soft-cap compaction (empty = SDK default; does not affect manual /compact)",
	},
	subagentDefaultModel: {
		labelZh: "子代理默认模型",
		labelEn: "Subagent Default Model",
		hintZh: "派生子代理时优先使用的专用模型（留空跟随主对话）",
		hintEn: "Dedicated model for subagents (empty to follow main chat)",
	},
	subagentMaxDepth: {
		labelZh: "子代理最大嵌套层数",
		labelEn: "Subagent Max Depth",
		hintZh: "主对话下最多几层子代理（0 = 不限制，1 = 子代理不能再派发）",
		hintEn: "Max subagent layers below the main chat (0 = unlimited, 1 = subagents cannot spawn)",
	},
	subagentAutoWakeMaxTurns: {
		labelZh: "子代理自动唤醒轮数上限",
		labelEn: "Subagent Max Auto-Wake Rounds",
		hintZh: "连续自动唤醒父对话的最大轮数（默认 5，0 = 不限制，挂起期间通知不丢）",
		hintEn: "Max consecutive autonomous wake rounds (default 5, 0 = unlimited; buffered on suspend)",
	},
	visionBridgeEnabled: {
		labelZh: "视觉桥 (看图转写)",
		labelEn: "Vision Bridge",
		hintZh: "主模型不具备识图能力时，自动使用带视觉的模型预先转写图片",
		hintEn: "Use vision model to describe images when main model is text-only",
	},
	visionBridgeModel: {
		labelZh: "视觉桥专属模型",
		labelEn: "Vision Bridge Model",
		hintZh: "用于看图转写的视觉模型 ID",
		hintEn: "Model ID used for vision transcription",
	},
	visionBridgePromptMode: {
		labelZh: "视觉桥提示词模式",
		labelEn: "Vision Bridge Prompt Mode",
		hintZh: "视觉桥转写提示词的追加/替换模式",
		hintEn: "Append or replace mode for vision bridge prompt",
	},
	visionBridgePrompt: {
		labelZh: "视觉桥提示词",
		labelEn: "Vision Bridge Prompt",
		hintZh: "指导视觉模型如何描述图片的系统提示词",
		hintEn: "System prompt guiding image transcription",
	},
	scmCommitMsgPromptMode: {
		labelZh: "Git 提交信息提示词模式",
		labelEn: "Git Commit Prompt Mode",
		hintZh: "AI 生成 Git 提交信息时的提示词模式",
		hintEn: "Prompt mode for AI-generated Git commit messages",
	},
	scmCommitMsgPrompt: {
		labelZh: "Git 提交信息提示词",
		labelEn: "Git Commit Prompt",
		hintZh: "指导 AI 根据 git diff 撰写提交信息的规范提示词",
		hintEn: "Prompt guiding AI to write commit messages from git diff",
	},
	planModePromptMode: {
		labelZh: "计划模式提示词模式",
		labelEn: "Plan Mode Prompt Mode",
		hintZh: "计划模式提示词的追加/替换模式",
		hintEn: "Append or replace mode for Plan Mode prompt",
	},
	planModePrompt: {
		labelZh: "计划模式提示词",
		labelEn: "Plan Mode Prompt",
		hintZh: "计划模式下限制模型只规划不施工的系统提示词",
		hintEn: "System prompt restricting agent to planning only",
	},
	goalModeEnabled: {
		labelZh: "目标模式 2.0",
		labelEn: "Goal Mode 2.0",
		hintZh: "主对话当审查者，服务端常驻执行对话协同干活",
		hintEn: "Reviewer/executor loop architecture for goal tasks",
	},
	parallelReminderEnabled: {
		labelZh: "并行编辑提醒",
		labelEn: "Parallel Edit Reminder",
		hintZh: "多个标签页同时编辑同一会话时的冲突告警",
		hintEn: "Warn when multiple tabs edit the same session",
	},
	uiLayout: {
		labelZh: "界面布局与图标排列",
		labelEn: "UI Layout & Icons",
		hintZh: "顶栏、底栏、左右侧边栏按钮的自定义顺序、可见性与对齐",
		hintEn: "Custom order, visibility and alignment for bars and docks",
	},
	disabledPlugins: {
		labelZh: "禁用的插件",
		labelEn: "Disabled Plugins",
		hintZh: "停用的 UI 插件列表",
		hintEn: "List of deactivated UI plugins",
	},
	thinkingWrap: {
		labelZh: "思考区自动折行",
		labelEn: "Thinking Block Word Wrap",
		hintZh: "思考展开区长文本是否自动折行",
		hintEn: "Enable word wrap inside thinking blocks",
	},
	toolsWrap: {
		labelZh: "工具调用自动折行",
		labelEn: "Tool Call Word Wrap",
		hintZh: "工具调用参数与结果长文本是否自动折行",
		hintEn: "Enable word wrap for tool parameters and results",
	},
	toolImagesEnabled: {
		labelZh: "工具调用图片渲染",
		labelEn: "Tool Image Preview",
		hintZh: "直接在工具卡片内渲染输出的图片文件",
		hintEn: "Render image output directly in tool cards",
	},
	keepRecentMessages: {
		labelZh: "常驻渲染消息数",
		labelEn: "Messages Kept In Full",
		hintZh: "消息列表尾部保持完整渲染的消息条数；更早的折叠为摘要行",
		hintEn: "Recent messages rendered in full; older ones collapse to summary rows",
	},
	reversePagination: {
		labelZh: "向上分页加载",
		labelEn: "Load Earlier Messages",
		hintZh: "默认仅挂载最近消息，向上滚动或点击加载更早历史，完全跳过视口占位符获得原生流畅度",
		hintEn: "Only mount recent messages; scroll up or click to load earlier history with zero placeholders",
	},
	showForkedParentSessions: {
		labelZh: "显示已分支的父会话",
		labelEn: "Show Forked Parent Sessions",
		hintZh: "编辑历史提问或派生分支后，在历史对话列表中同时保留原父会话",
		hintEn: "Keep original parent sessions visible in the history list after editing a message or forking",
	},
	retainFinishedConversations: {
		labelZh: "保留已结束的运行对话",
		labelEn: "Retain Finished Running Conversations",
		hintZh: "切换对话或新建对话时，已结束（空闲）的对话依然保留在运行列表中，直到手动移出",
		hintEn: "Keep finished (idle) conversations in the Running Chats list when switching away until manually removed",
	},
	openRecentSessionOnProjectSwitch: {
		labelZh: "切换项目时打开最近会话",
		labelEn: "Open Recent Session on Project Switch",
		hintZh: "切换到新项目时自动打开该项目最近的会话；关闭后切换项目将直接创建全新空白对话",
		hintEn:
			"Automatically resume the most recent session when switching projects. When off, always create a fresh blank chat",
	},
	quickPhrases: {
		labelZh: "快捷短语列表",
		labelEn: "Quick Phrases List",
		hintZh: "输入框上方的常用提示短语快捷按钮",
		hintEn: "Quick prompt phrase buttons above composer",
	},
	quickPhrasesEnabled: {
		labelZh: "启用快捷短语",
		labelEn: "Enable Quick Phrases",
		hintZh: "是否在输入框上方显示快捷短语药丸栏",
		hintEn: "Display quick phrases bar above composer",
	},
	minimalNewChat: {
		labelZh: "极简新对话",
		labelEn: "Minimalist New Chat",
		hintZh: "新对话隐藏提示词模板并隐藏快捷短语，呈现现代极简风格",
		hintEn: "Hide prompt templates and quick phrases on new chat for a clean modern look",
	},
	preserveDraftAcrossConversations: {
		labelZh: "输入框文字跨对话保留",
		labelEn: "Preserve Composer Text Across Conversations",
		hintZh:
			"开启：输入文字切换别的会话不清空；关闭：仅保留当前会话文字，切换其他会话时清空或显示该会话已保留文字，切回时恢复当前会话文字",
		hintEn:
			"Enabled: keep composer text when switching conversations. Disabled: retain text only for the current conversation",
	},
	devNoCache: {
		labelZh: "开发者免缓存模式",
		labelEn: "Developer No-Cache Mode",
		hintZh: "前端静态资源强制请求最新，不走缓存",
		hintEn: "Bypass browser cache for static frontend assets",
	},
	autoReload: {
		labelZh: "插件自动热重载",
		labelEn: "Auto Reload on File Change",
		hintZh: "本地插件文件变更时自动刷新插件运行时",
		hintEn: "Automatically reload plugins when files change",
	},
	defaultAgentPreset: {
		labelZh: "默认智能体预设",
		labelEn: "Default Agent Preset",
		hintZh: "新建会话时默认加载的智能体预设（DSH 多引擎）",
		hintEn: "Default agent preset applied to new sessions (DSH)",
	},
	defaultPermissionPreset: {
		labelZh: "默认权限预设",
		labelEn: "Default Permission Preset",
		hintZh: "新建会话时默认加载的权限预设",
		hintEn: "Default permission preset applied to new sessions",
	},
} as const satisfies Record<PresetFieldName, PresetFieldInfo>;

export function presetFieldLabel(field: string, lang: "zh" | "en" = "zh"): string {
	const meta = (PRESET_FIELD_META as Record<string, PresetFieldInfo>)[field];
	if (!meta) return field;
	return lang === "zh" ? meta.labelZh : meta.labelEn;
}

export function presetFieldHint(field: string, lang: "zh" | "en" = "zh"): string {
	const meta = (PRESET_FIELD_META as Record<string, PresetFieldInfo>)[field];
	if (!meta) return "";
	return (lang === "zh" ? meta.hintZh : meta.hintEn) || "";
}

export interface PresetFieldValueFormat {
	summary: string;
	detail?: string;
}

export function formatPresetFieldValue(
	field: string,
	value: unknown,
	lang: "zh" | "en" = "zh",
): PresetFieldValueFormat {
	const isZh = lang === "zh";

	if (value === undefined || value === null) {
		return { summary: isZh ? "未配置（跟随当前值）" : "Not configured (keeps current)" };
	}

	if (field === "disabledAgentTools") {
		const disabledList = Array.isArray(value)
			? value.filter((x): x is string => typeof x === "string" && Boolean(x))
			: [];
		const enabledList = resolveEnabledAgentTools(disabledList);
		if (disabledList.length === 0) {
			return {
				summary: isZh
					? `全部启用（共 ${enabledList.length} 个可用工具）`
					: `All enabled (${enabledList.length} available tools)`,
				detail: [
					`[${isZh ? "已启用可用工具" : "Enabled Tools"} (${enabledList.length})]`,
					...enabledList.map((item) => `  ✓ ${item}`),
				].join("\n"),
			};
		}
		return {
			summary: isZh
				? `启用 ${enabledList.length} 个，禁用 ${disabledList.length} 个（默认没开即关）`
				: `Enabled ${enabledList.length}, disabled ${disabledList.length} (defaults to off)`,
			detail: [
				`[${isZh ? "已启用可用配置" : "Enabled Tools"} (${enabledList.length})]`,
				...enabledList.map((item) => `  ✓ ${item}`),
				"",
				`[${isZh ? "已禁用（默认没开即关）" : "Disabled Tools (defaults to off)"} (${disabledList.length})]`,
				...disabledList.map((item) => `  ✗ ${item}`),
			].join("\n"),
		};
	}

	if (field === "disabledPluginTools") {
		const list = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && Boolean(x)) : [];
		if (list.length === 0) {
			return { summary: isZh ? "全部启用（无禁用）" : "All enabled (none disabled)" };
		}
		return {
			summary: isZh
				? `禁用 ${list.length} 个插件工具（${list.join(", ")}）`
				: `Disabled ${list.length} plugin tool(s): ${list.join(", ")}`,
			detail: list.map((item) => `- ${item}`).join("\n"),
		};
	}

	if (field === "toolPromptOverrides") {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { summary: isZh ? "无覆盖" : "No overrides" };
		}
		const map = value as Record<string, { description?: string; promptSnippet?: string; promptGuidelines?: string[] }>;
		const tools = Object.keys(map);
		if (tools.length === 0) {
			return { summary: isZh ? "无覆盖（使用官方出厂提示词）" : "No overrides (uses factory defaults)" };
		}
		const detailLines: string[] = [];
		for (const [toolName, ov] of Object.entries(map)) {
			detailLines.push(`[${toolName}]`);
			if (ov.description) detailLines.push(`  ${isZh ? "描述" : "Description"}: ${ov.description}`);
			if (ov.promptSnippet) detailLines.push(`  ${isZh ? "触发摘要" : "Snippet"}: ${ov.promptSnippet}`);
			if (ov.promptGuidelines && ov.promptGuidelines.length > 0) {
				detailLines.push(`  ${isZh ? "使用指南" : "Guidelines"}:`);
				for (const g of ov.promptGuidelines) detailLines.push(`    • ${g}`);
			}
			detailLines.push("");
		}
		return {
			summary: isZh
				? `覆盖了 ${tools.length} 个工具的提示词（${tools.join(", ")}）`
				: `Overrides prompts for ${tools.length} tool(s): ${tools.join(", ")}`,
			detail: detailLines.join("\n").trimEnd(),
		};
	}

	if (
		field === "disabledSkills" ||
		field === "disabledExtensions" ||
		field === "reviewDisabledSkills" ||
		field === "promptDisabled"
	) {
		const list = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && Boolean(x)) : [];
		if (list.length === 0) {
			return { summary: isZh ? "全部启用（无禁用）" : "All enabled (none disabled)" };
		}
		return {
			summary: isZh
				? `禁用 ${list.length} 项（${list.join(", ")}）`
				: `Disabled ${list.length} item(s): ${list.join(", ")}`,
			detail: list.map((item) => `- ${item}`).join("\n"),
		};
	}

	if (field === "skillsFullText") {
		const list = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && Boolean(x)) : [];
		if (list.length === 0) {
			return { summary: isZh ? "无（全部按需加载）" : "None (loaded on demand)" };
		}
		return {
			summary: isZh
				? `常驻 ${list.length} 项技能全文（${list.join(", ")}）`
				: `Pinned full text for ${list.length} skill(s): ${list.join(", ")}`,
			detail: list.map((item) => `- ${item}`).join("\n"),
		};
	}

	if (field === "skillsCatalogMaxDesc" || field === "skillsCatalogBudget") {
		const n = Number(value);
		const zeroText = isZh ? "不限" : "No limit";
		const valText = n === 0 ? zeroText : isZh ? `${n} 字符` : `${n} chars`;
		return { summary: valText };
	}
	if (field === "skillsMaxFileBytes" || field === "skillsFullTextMaxBytes") {
		const n = Number(value);
		const zeroText = isZh ? "不限" : "No limit";
		const valText =
			n === 0
				? zeroText
				: isZh
					? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KB`
					: `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KB`;
		return { summary: valText };
	}
	if (field === "skillsCatalogShowLocation") {
		return { summary: value ? (isZh ? "开启" : "Enabled") : isZh ? "关闭" : "Disabled" };
	}

	if (
		field === "customSystemPrompt" ||
		field === "promptTemplate" ||
		field === "reviewPrompt" ||
		field === "visionBridgePrompt" ||
		field === "scmCommitMsgPrompt" ||
		field === "planModePrompt"
	) {
		const s = typeof value === "string" ? value : "";
		if (!s.trim()) {
			return { summary: isZh ? "（空）" : "(empty)" };
		}
		const preview = s.length > 60 ? `${s.slice(0, 60)}…` : s;
		return {
			summary: isZh
				? `包含 ${s.length} 字符：${preview.replace(/\s+/g, " ")}`
				: `${s.length} chars: ${preview.replace(/\s+/g, " ")}`,
			detail: s,
		};
	}

	if (field === "promptOverrides") {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { summary: isZh ? "无覆盖" : "No overrides" };
		}
		const map = value as Record<string, string>;
		const sections = Object.keys(map);
		if (sections.length === 0) {
			return { summary: isZh ? "无覆盖" : "No overrides" };
		}
		const detailLines: string[] = [];
		for (const [sec, text] of Object.entries(map)) {
			detailLines.push(`[${sec}] (${text.length} chars)`);
			detailLines.push(text);
			detailLines.push("");
		}
		return {
			summary: isZh
				? `覆盖 ${sections.length} 个内置段落（${sections.join(", ")}）`
				: `Overrides ${sections.length} section(s): ${sections.join(", ")}`,
			detail: detailLines.join("\n").trimEnd(),
		};
	}

	if (field === "codemodeMode") {
		return {
			summary:
				value === "only"
					? isZh
						? "纯代码模式 (only，仅通过沙箱脚本调用工具)"
						: "Strict code mode (only, sandbox scripts only)"
					: isZh
						? "常规模式 (on，常规可用，支持脚本批处理)"
						: "Standard mode (on, direct & scripts)",
		};
	}
	if (
		field === "promptMode" ||
		field === "visionBridgePromptMode" ||
		field === "scmCommitMsgPromptMode" ||
		field === "planModePromptMode"
	) {
		return {
			summary:
				value === "replace"
					? isZh
						? "替换内置系统提示词 (replace)"
						: "Replaces built-in system prompt (replace)"
					: isZh
						? "追加到系统提示词后 (append)"
						: "Appends to system prompt (append)",
		};
	}

	if (field === "uiLayout") {
		if (!value || typeof value !== "object") {
			return { summary: isZh ? "默认布局" : "Default layout" };
		}
		return {
			summary: isZh ? "包含自定义工具栏、停靠栏排列与对齐设置" : "Custom layout, bar order and dock alignment",
		};
	}

	if (typeof value === "boolean") {
		if (field === "toolLazyLoading") {
			return {
				summary: value
					? isZh
						? "开启（仅核心工具常驻，其余按需加载）"
						: "Enabled (core only, others on-demand)"
					: isZh
						? "关闭（所有工具全部直接挂载）"
						: "Disabled (all tools loaded)",
			};
		}
		if (field === "terminalBash") {
			return {
				summary: value
					? isZh
						? "开启（命令分流到可见交互终端）"
						: "Enabled (routes to interactive terminal)"
					: isZh
						? "关闭（后台执行）"
						: "Disabled (runs in background)",
			};
		}
		if (field === "toolApprovalEnabled") {
			return {
				summary: value
					? isZh
						? "开启（写操作与高危工具需人工审批）"
						: "Enabled (approval needed for write tools)"
					: isZh
						? "关闭（直接放行执行）"
						: "Disabled (auto allow)",
			};
		}
		if (field === "questionnaireEnabled") {
			return {
				summary: value
					? isZh
						? "开启（遇到歧义向用户发起交互问答）"
						: "Enabled (interactive questions allowed)"
					: isZh
						? "关闭"
						: "Disabled",
			};
		}
		return { summary: value ? (isZh ? "开启" : "Enabled") : isZh ? "关闭" : "Disabled" };
	}

	if (typeof value === "number") {
		if (field === "codemodeInlineBudget") {
			return { summary: `${value} tokens` };
		}
		if (field === "softCapTokens") {
			return { summary: value > 0 ? `${value} tokens` : isZh ? "跟随默认 (16384 tokens)" : "Default (16384 tokens)" };
		}
		if (field === "retryMaxAttempts") {
			return { summary: isZh ? `最大重试 ${value} 次` : `Max ${value} attempts` };
		}
		if (field === "toolWatchdogTimeoutMs") {
			return { summary: isZh ? `${Math.round(value / 60000)} 分钟` : `${Math.round(value / 60000)} min` };
		}
		if (field === "bgAutoCleanupMin") {
			return {
				summary:
					value > 0 ? (isZh ? `闲置 ${value} 分钟后清理` : `clean after ${value} min idle`) : isZh ? "关闭" : "Off",
			};
		}
		if (field === "terminalBashIdleMs" || field === "terminalBashMaxForegroundMs") {
			return { summary: isZh ? `${Math.round(value / 1000)} 秒` : `${Math.round(value / 1000)} s` };
		}
		return { summary: String(value) };
	}

	if (field === "quickPhrases") {
		const list = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
		return {
			summary: isZh ? `包含 ${list.length} 条快捷短语` : `${list.length} quick phrase(s)`,
			detail: list.map((item, idx) => `${idx + 1}. ${item}`).join("\n"),
		};
	}

	if (field === "subagentDefaultModel" || field === "visionBridgeModel") {
		const s = typeof value === "string" ? value.trim() : "";
		return {
			summary: s ? (isZh ? `指定模型：${s}` : `Model: ${s}`) : isZh ? "跟随主对话模型" : "Follows main chat model",
		};
	}

	return { summary: String(value) };
}
