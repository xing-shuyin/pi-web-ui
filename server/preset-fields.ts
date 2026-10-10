/**
 * preset-fields.ts — 预设能携带哪些设置字段 + 它们归到哪个分组（**零依赖**纯模块）。
 *
 * 为什么单独一个文件：字段清单要同时被
 *   - 服务端 `preset-share.ts`（白名单净化 / 交换文档）与 `settings-service.ts`（快照/应用）用，
 *   - 前端导入预览的「按分组勾选」用（`web/src/components/PresetShareModal.tsx`）。
 * 而 `preset-share.ts` 依赖 `node:child_process` / `node:fs`，浏览器里 import 会炸；
 * 本文件不 import 任何东西，两端都能安全引用（同 `prompt-composer.ts` / `tool-manager.ts` 的做法）。
 *
 * 纪律：
 *   1. 这里只描述**元数据**（字段名 / 分组 / 文案 key），净化与归一化仍在 preset-share 里；
 *   2. `PRESET_FIELD_NAMES` 必须覆盖 `ClientSettings` 的每个字段 —— 单测
 *      `tests/unit/preset-share.test.ts` 用类型 + 快照双重守卫，漏字段会红；
 *   3. 分组只影响 UI 折叠与「勾一组」，不影响写入逻辑（导入按字段名过滤）。
 */

import { resolveEnabledAgentTools } from "./tool-manager.js";

/** 预设字段分组（导入预览里的折叠块；顺序即展示顺序）。 */
export const PRESET_GROUP_ORDER = ["prompt", "tools", "terminal", "skills", "ai", "ui", "engine"] as const;
export type PresetFieldGroup = (typeof PRESET_GROUP_ORDER)[number];

/**
 * 字段 → 分组。key 集合 = 预设可携带的全部设置字段名。
 * 前端按 `PRESET_GROUP_ORDER` 渲染勾选块，组的名字走 i18n `presetGroup<Xxx>`。
 *
 * 用 `as const` 保留字面量类型：`PresetFieldName` 由此导出，单测用它做
 * 「`ClientSettings` 的每个字段都在这里」的**编译期**守卫。
 */
export const PRESET_FIELD_GROUPS = {
	// 提示词（主会话 + 审查者）
	prompt: [
		"promptMode",
		"customSystemPrompt",
		"promptTemplate",
		"promptOverrides",
		"reviewPrompt",
		"reviewDisabledSkills",
	],
	// 工具开关与模型可见文案
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
		"editSoftEnabled",
		"terminalToolsEnabled",
	],
	// 终端接管
	terminal: ["terminalBash", "terminalBashIdleMs", "terminalBashMaxForegroundMs"],
	// 技能与扩展
	skills: ["disabledSkills", "disabledExtensions", "skillsFullText"],
	// 模型侧行为与各专用提示词
	ai: [
		"retryMaxAttempts",
		"softCapTokens",
		"softCapByModel",
		"subagentDefaultModel",
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
	// 界面与交互偏好
	ui: [
		"uiLayout",
		"disabledPlugins",
		"thinkingWrap",
		"toolsWrap",
		"toolImagesEnabled",
		"keepRecentMessages",
		"bgAutoCleanupMin",
		"quickPhrases",
		"quickPhrasesEnabled",
		"devNoCache",
		"autoReload",
	],
	// 引擎/多引擎默认（DSH 用）
	engine: ["defaultAgentPreset", "defaultPermissionPreset"],
} as const;

/** 全部预设字段名（字面量联合）—— 编译期用它与 `keyof ClientSettings` 对账。 */
export type PresetFieldName = (typeof PRESET_FIELD_GROUPS)[PresetFieldGroup][number];

/** 全部字段名（组顺序 → 组内顺序；去重保护）。 */
export const PRESET_FIELD_NAMES: readonly PresetFieldName[] = (() => {
	const out: PresetFieldName[] = [];
	for (const g of PRESET_GROUP_ORDER) for (const f of PRESET_FIELD_GROUPS[g]) if (!out.includes(f)) out.push(f);
	return out;
})();

/** 某字段属于哪个分组（未知字段返回 undefined；前端过滤用）。 */
export function presetFieldGroup(field: string): PresetFieldGroup | undefined {
	for (const g of PRESET_GROUP_ORDER) {
		if ((PRESET_FIELD_GROUPS[g] as readonly string[]).includes(field)) return g;
	}
	return undefined;
}

/** 按分组把一组字段名摊成「组 → 命中的字段」（空组不给；组顺序固定）。 */
export function groupPresetFields(fields: readonly string[]): { group: PresetFieldGroup; fields: string[] }[] {
	const set = new Set(fields);
	const out: { group: PresetFieldGroup; fields: string[] }[] = [];
	for (const g of PRESET_GROUP_ORDER) {
		const hit = PRESET_FIELD_GROUPS[g].filter((f) => set.has(f));
		if (hit.length > 0) out.push({ group: g, fields: hit });
	}
	return out;
}

/** 过滤出合法字段名（去重、保持 `PRESET_FIELD_NAMES` 顺序）——导入选择用。 */
export function normalizePresetFieldSelection(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const wanted = new Set(v.filter((x): x is string => typeof x === "string"));
	return PRESET_FIELD_NAMES.filter((f) => wanted.has(f));
}

/** 字段元数据：中文名称、英文名称及简述。 */
export interface PresetFieldInfo {
	labelZh: string;
	labelEn: string;
	hintZh?: string;
	hintEn?: string;
}

/** 预设中 47 个设置项的人类可读元数据映射（支持 satisfies 编译期完整性校验）。 */
export const PRESET_FIELD_META = {
	// prompt
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
	// tools
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
	// terminal
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
	// skills
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
	// ai
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
	subagentDefaultModel: {
		labelZh: "子代理默认模型",
		labelEn: "Subagent Default Model",
		hintZh: "派生子代理时优先使用的专用模型（留空跟随主对话）",
		hintEn: "Dedicated model for subagents (empty to follow main chat)",
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
	// ui
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
	// engine
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

/** 获取字段的人类可读标签。 */
export function presetFieldLabel(field: string, lang: "zh" | "en" = "zh"): string {
	const meta = (PRESET_FIELD_META as Record<string, PresetFieldInfo>)[field];
	if (!meta) return field;
	return lang === "zh" ? meta.labelZh : meta.labelEn;
}

/** 获取字段的功能简述。 */
export function presetFieldHint(field: string, lang: "zh" | "en" = "zh"): string {
	const meta = (PRESET_FIELD_META as Record<string, PresetFieldInfo>)[field];
	if (!meta) return "";
	return (lang === "zh" ? meta.hintZh : meta.hintEn) || "";
}

/** 字段值格式化回执。 */
export interface PresetFieldValueFormat {
	/** 一行简短摘要（展示在勾选框右侧）。 */
	summary: string;
	/** 详细内容（可展开查看文本、覆盖明细等）。 */
	detail?: string;
}

/**
 * 格式化预设中某字段的具体值：生成简要摘要 + 可展开的详细文本。
 * 解决「用户不知道预设开了哪些工具、改了哪些提示词」的透明度问题。
 */
export function formatPresetFieldValue(
	field: string,
	value: unknown,
	lang: "zh" | "en" = "zh",
): PresetFieldValueFormat {
	const isZh = lang === "zh";

	// 1. 未定义或 null
	if (value === undefined || value === null) {
		return { summary: isZh ? "未配置（跟随当前值）" : "Not configured (keeps current)" };
	}

	// 2. 工具开关列表
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

	// 3. 工具提示词覆盖
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

	// 4. 技能 / 扩展禁用列表
	if (field === "disabledSkills" || field === "disabledExtensions" || field === "reviewDisabledSkills") {
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

	// 5. 技能全文常驻
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

	// 6. 提示词文本
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

	// 7. 逐段提示词覆盖 (promptOverrides)
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

	// 8. 模式类字段
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

	// 9. 界面布局 (uiLayout)
	if (field === "uiLayout") {
		if (!value || typeof value !== "object") {
			return { summary: isZh ? "默认布局" : "Default layout" };
		}
		return {
			summary: isZh ? "包含自定义工具栏、停靠栏排列与对齐设置" : "Custom layout, bar order and dock alignment",
		};
	}

	// 10. 布尔开关
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

	// 11. 数字配置
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

	// 12. 快捷短语列表
	if (field === "quickPhrases") {
		const list = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
		return {
			summary: isZh ? `包含 ${list.length} 条快捷短语` : `${list.length} quick phrase(s)`,
			detail: list.map((item, idx) => `${idx + 1}. ${item}`).join("\n"),
		};
	}

	// 13. 模型选择
	if (field === "subagentDefaultModel" || field === "visionBridgeModel") {
		const s = typeof value === "string" ? value.trim() : "";
		return {
			summary: s ? (isZh ? `指定模型：${s}` : `Model: ${s}`) : isZh ? "跟随主对话模型" : "Follows main chat model",
		};
	}

	return { summary: String(value) };
}
