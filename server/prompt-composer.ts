/**
 * 主会话系统提示词 = 自由组合模板（compose）。
 *
 * 模板里的 `{{token}}` 在每次 agent run 前展开为对应「来源」的提示词块；每个
 * token 可单独覆盖——overrides 里有内容就用覆盖文本，否则用该来源的自动内容。
 * 这样既可自由排序/增删/穿插自己的话，也可只替换某一个来源而不影响其他自动段
 * （工具列表、项目上下文等仍由 SDK 用最新数据重新生成）。
 *
 * token 列表及默认顺序镜像 buildSystemPrompt（SDK dist/core/system-prompt.js）
 * 默认分支的拼装顺序：
 *     soul → tools → guidelines → pi_docs → append → persona → terminal →
 *     markers → context → skills → cwd
 *
 * （bash 管道限制不需要独立段：它属于 bash 工具的用法说明，已写进工具自身
 *  description，随工具走；compose 里不再单设 {{pipe}} 来源。）
 *
 * 本模块是纯函数（不 import SDK / node），浏览器端可复用（SettingsModal 需要
 * DEFAULT_PROMPT_TEMPLATE 与 token 元数据）。
 */

import { getServerBlock, pick, type ServerLang } from "./i18n.js";

/** 全部来源 token。默认模板顺序即此数组顺序。 */
export const PROMPT_TOKENS = [
	"soul", // 内置灵魂提示词（persona；有 SYSTEM.md 时其内容）
	"tools", // Available tools 工具列表（含各工具 snippet + "In addition…" 句）
	"guidelines", // Guidelines 行为准则段
	"pi_docs", // Pi documentation 文档指引（指向 pi 包路径）
	"append", // 追加段（APPEND_SYSTEM.md 内容；覆盖 = 自定义追加文字）
	"persona", // Windows persona（仅 win32）
	"terminal", // 终端工具使用引导（「终端工具」开关开时）
	"markers", // 内置标记工具引导（markers 开启时）
	"context", // 项目上下文 <project_context>（AGENTS.md 等）
	"skills", // 技能段 <available_skills>
	"cwd", // Current working directory 行
] as const;

/** 只读来源（设置面板只读展示、不提供覆盖输入）：这些 token 的内容由系统/环境
 *  在每次 run 时动态生成（工具集、项目文件、技能、工作目录、开关状态），用户无法
 *  在设置里预设其内容。反之 soul / guidelines / append 是用户内容层，可编辑。
 *  注意：只读是「设置面板 UI」层面；服务端 override 机制（renderPromptTemplate）
 *  仍保留，以兼容旧配置与编程调用。 */
export const READONLY_PROMPT_SOURCES = [
	"tools", // 工具列表（运行时时按已注册工具动态生成）
	"pi_docs", // Pi 文档指引（指向已安装 pi 包路径，由安装位置决定）
	"persona", // Windows persona（仅 win32，平台固定）
	"terminal", // 终端工具使用引导（随「终端工具」开关）
	"markers", // 内置标记工具引导（随 markers 开关）
	"context", // 项目上下文（AGENTS.md / CLAUDE.md 收集结果）
	"skills", // 技能段（来自环境/技能文件）
	"cwd", // 当前工作目录
] as const;

export type PromptToken = (typeof PROMPT_TOKENS)[number];

/** 仅当 token 是只读来源时返回 true（设置面板用于判断是否展示覆盖输入框）。 */
export function isReadonlyPromptSource(token: string): boolean {
	return (READONLY_PROMPT_SOURCES as readonly string[]).includes(token);
}

/** 默认模板：全部 token 按自然顺序以空行连接 —— 无覆盖、不改动时渲染结果 ≈
 *  SDK 默认拼装的完整提示词。 */
export const DEFAULT_PROMPT_TEMPLATE = PROMPT_TOKENS.map((t) => `{{${t}}}`).join("\n\n");

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 模板里出现的全部 token（含未知名，供 UI 提示）。 */
export function collectTemplateTokens(template: string): string[] {
	const out: string[] = [];
	for (const m of template.matchAll(TOKEN_RE)) {
		if (!out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

/** 空模板 = 默认模板。 */
export function effectiveTemplate(template: string): string {
	const t = (template ?? "").trim();
	return t || DEFAULT_PROMPT_TEMPLATE;
}

/** 该来源是否有「自动内容」之外的覆盖。 */
export function overrideOf(overrides: Record<string, string> | undefined, token: string): string {
	const v = overrides?.[token];
	return v && v.trim() ? v : "";
}

/** 组装每个来源的自动内容所需的全部输入（由 agent-service 在 run 时收集）。 */
export interface PromptComposerInputs {
	/** 当前工作目录（反斜杠会转正斜杠）。 */
	cwd: string;
	/** SYSTEM.md 文件内容（项目/全局），存在时作为 {{soul}} 默认；缺省用内置默认。 */
	systemPromptFile?: string;
	/** 内置灵魂段落（无 SYSTEM.md 时 {{soul}} 的自动内容）。 */
	builtinSoul: string;
	/** 活动工具名。 */
	selectedTools: string[];
	/** 工具**延迟加载**模式：true 时 {{tools}} 列的是完整工具目录（catalogTools），
	 *  并在末尾加一段**恒定**的提示说明「目录里的工具 schema 未附、用 load_tools 获取」。
	 *  关键：这段文字不得随已加载集合变化 —— 系统提示词一变，供应商的前缀缓存（prompt
	 *  cache）就整段失效（见 docs/tool-context-budget.md）。 */
	lazy?: boolean;
	/** 延迟加载时的工具目录（全部可用工具，顺序稳定 = 注册表顺序）。 */
	catalogTools?: string[];
	/** 活动工具的 prompt snippet（name → snippet）。 */
	toolSnippets: Record<string, string>;
	/** 工具参数签名简短说明（name → "(param1: hint, param2?: hint)"）。 */
	toolSignatures?: Record<string, string>;
	/** 活动工具聚合的 prompt guidelines。 */
	toolGuidelines: string[];
	/** Pi 包路径（README.md / docs / examples 目录）。 */
	piReadme: string;
	piDocs: string;
	piExamples: string;
	/** APPEND_SYSTEM.md 文件内容（SDK 追加段的 base；{{append}} 自动内容）。 */
	appendFiles: string[];
	/** Windows persona（非 win32 传空串 → {{persona}} 自动为空）。 */
	windowsPersona: string;
	/** 终端工具使用引导（「终端工具」关时传空串）。 */
	terminalGuidance: string;
	/** 标记工具引导（markers 关时为空串）。 */
	markersGuidance: string;
	/** 项目上下文文件（AGENTS.md 等，path + content）。 */
	contextFiles: { path: string; content: string }[];
	/** 可见技能（已按禁用集过滤、disableModelInvocation=false）。
	 * content 缺省 = 只渲染名录（模型用 skill 工具按名自取全文）；skillsFullText 开时
	 * agent-service 会把 SKILL.md 正文填进来，{{skills}} 展开为全文注入。 */
	skills: { name: string; description: string; filePath: string; content?: string }[];
	/** skill 全文注入名单（默认空 = 名录模式）。名单里的技能有 content 则按
	 * 全文展开；无 content 的条目回落名录行。 */
	skillsFullText?: readonly string[];
	/**
	 * 服务端语言（issue #91）：面向模型的提示词段（soul / guidelines / pi_docs /
	 * context / skills）按此选英文版/中文版。缺省 "en"（英文默认；非 zh 一律英文）。
	 * 工具列表段（tools / toolsSchema）与 cwd 行本来就是英文，保持不动。
	 * agent-service 接线：composeInputs 里填 getLang()。
	 */
	lang?: ServerLang;
}

/** 内置默认灵魂段落（buildSystemPrompt 默认分支的开头，与 SDK 同步维护）。 */
export const BUILTIN_SOUL =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/**
 * 内置默认灵魂段落的中文版（issue #91）：lang === "zh" 且调用方未自定义
 * builtinSoul 时 {{soul}} 用它。英文版 BUILTIN_SOUL 保持原样（英文默认）。
 */
export const BUILTIN_SOUL_ZH =
	"你是运行在 pi（一个编码智能体框架）中的专业编码助手。你通过读取文件、执行命令、编辑代码和新建文件来帮助用户。";

/** Pi documentation 段模板 —— 与 SDK buildSystemPrompt 默认分支一致（路径由调用方注入）。 */
export function buildPiDocsText(readme: string, docs: string, examples: string, lang: ServerLang = "en"): string {
	if (lang === "zh") {
		return [
			"Pi 文档（仅当用户问及 pi 本身、其 SDK、扩展、主题、技能或 TUI 时阅读）：",
			`- 主文档：${readme}`,
			`- 更多文档：${docs}`,
			`- 示例：${examples}（扩展、自定义工具、SDK）`,
			"- 阅读 pi 文档或示例时，在「更多文档」下找 docs/...、在「示例」下找 examples/...，不要按当前工作目录解析",
			"- 被问及以下主题时：扩展（docs/extensions.md、examples/extensions/）、主题（docs/themes.md）、技能（docs/skills.md）、提示词模板（docs/prompt-templates.md）、TUI 组件（docs/tui.md）、快捷键（docs/keybindings.md）、SDK 集成（docs/sdk.md）、自定义服务商（docs/custom-provider.md）、添加模型（docs/models.md）、pi 包（docs/packages.md）、环境变量（docs/environment-variables.md）",
			"- 处理 pi 相关主题时，先阅读文档和示例，并跟随其中的 .md 交叉引用，再动手实现",
			"- pi 的 .md 文件务必通读全文，并跟随其中指向相关文档的链接（例如 TUI API 细节见 tui.md）",
		].join("\n");
	}
	return [
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		`- Main documentation: ${readme}`,
		`- Additional docs: ${docs}`,
		`- Examples: ${examples} (extensions, custom tools, SDK)`,
		"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
		"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
	].join("\n");
}

/** Guidelines 段：文件探索引导 + 工具 promptGuidelines（去重）+ 固定两行。
 *  与 buildSystemPrompt 默认分支的聚合规则一致。 */
function buildGuidelinesText(inputs: PromptComposerInputs): string {
	const lang: ServerLang = inputs.lang ?? "en";
	const selected = new Set(inputs.selectedTools);
	const lines: string[] = [];
	const add = (g: string) => {
		const t = g.trim();
		if (t && !lines.includes(t)) lines.push(t);
	};
	const has = (n: string) => selected.has(n);
	if ((has("bash") || has("powershell")) && !has("grep") && !has("find") && !has("ls")) {
		add(
			has("bash") && has("powershell")
				? pick(
						lang,
						"涉及列出、搜索、查找文件等文件操作时，使用 bash 或 PowerShell",
						"Use bash or PowerShell for file operations like listing, searching, and finding files",
						"prompt.guidelines.bash.powershell",
					)
				: pick(
						lang,
						"涉及 ls、rg、find 等文件操作时，使用 bash",
						"Use bash for file operations like ls, rg, find",
						"prompt.guidelines.bash.basic",
					),
		);
	}
	for (const g of inputs.toolGuidelines) add(g);
	add(pick(lang, "回答要简洁", "Be concise in your responses", "prompt.guidelines.be.concise"));
	add(
		pick(
			lang,
			"处理文件时清楚地给出文件路径",
			"Show file paths clearly when working with files",
			"prompt.guidelines.show.paths",
		),
	);
	return `${pick(lang, "指导原则：", "Guidelines:", "prompt.guidelines.title")}\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** 技能段文本（不含前导空行）。与 SDK formatSkillsForPrompt 一致。
 * fullText = true 全员全文注入（oh-my-pi 式：标题 + 引用描述 + body 全文）；
 * 传技能名数组 = 只注入名单里的；content 缺失的条目回落列表行，不中断渲染。 */
export function buildSkillsText(
	skills: PromptComposerInputs["skills"],
	lang: ServerLang = "en",
	fullText: boolean | readonly string[] = false,
): string {
	const visible = skills.filter((s) => !(s as { disableModelInvocation?: boolean }).disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		pick(
			lang,
			"以下技能为特定任务提供专门的指令。",
			"The following skills provide specialized instructions for specific tasks.",
			"prompt.skills.intro.specialized",
		),
		pick(
			lang,
			"当任务与某技能的描述相符时，用 skill 工具按名称加载该技能全文。",
			"Use the skill tool to load a skill's full text by name when the task matches its description.",
			"prompt.skills.intro.use.skill",
		),
		pick(
			lang,
			"当技能文件引用相对路径时，以技能目录（SKILL.md 的父目录 / 该路径的 dirname）为基准解析，并在工具命令中使用解析后的绝对路径。",
			"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
			"prompt.skills.intro.resolve.path",
		),
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		// 全文模式且有内容：oh-my-pi 注入格式（### Skill: 名 / > 描述 / 全文）。
		const inject = fullText === true || (Array.isArray(fullText) && fullText.includes(skill.name));
		if (inject && skill.content?.trim()) {
			lines.push(`### Skill: ${skill.name}`);
			if (skill.description.trim()) lines.push(`> ${skill.description.trim()}`);
			lines.push("", skill.content.trim(), "");
			continue;
		}
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/** 项目上下文块（不含前导空行）。 */
function buildContextText(files: PromptComposerInputs["contextFiles"], lang: ServerLang = "en"): string {
	if (files.length === 0) return "";
	return [
		"<project_context>",
		"",
		pick(lang, "项目专属指令与规范：", "Project-specific instructions and guidelines:", "prompt.context.title"),
		"",
		...files.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`),
		"",
		"</project_context>",
	].join("\n");
}

/** 工具列表块：工具列表（延迟加载时列完整目录）+ 恒定提示 + "In addition…" 句。
 *
 * 延迟加载下这里**只依赖目录本身**（不依赖「哪些已加载」）：系统提示词是供应商
 * 前缀缓存的第一段，只要它不变，加载工具造成的只是 tools 数组的追加（前缀不变的
 * 增量），缓存才不会被我们自已打坏。 */
function buildToolsText(inputs: PromptComposerInputs, lang: ServerLang): string {
	const listed = inputs.lazy ? (inputs.catalogTools ?? inputs.selectedTools) : inputs.selectedTools;
	const visible = listed.filter((n) => !!inputs.toolSnippets[n]);
	const toolsList =
		visible.length > 0
			? visible
					.map((n) => {
						const sig = inputs.toolSignatures?.[n] ? ` ${inputs.toolSignatures[n]}` : "";
						return `- ${n}:${sig} ${inputs.toolSnippets[n]}`;
					})
					.join("\n")
			: "(none)";
	const parts = [`Available tools:\n${toolsList}`];
	if (inputs.lazy) {
		parts.push(
			pick(
				lang,
				"核心工具（bash, read, edit, write）及 `load_tools` 始终常驻可用，无需加载。上表中其他尚未附加参数 schema 的工具，调用前先用 `load_tools` 附加上完整参数（本对话后续轮次持续有效）。",
				"Core tools (bash, read, edit, write) and `load_tools` are always active and ready to use. Other tools above do NOT have their parameter schema attached yet: pass their names to `load_tools` before calling them to attach full schemas for the rest of this conversation.",
				"prompt.tools.lazy",
			),
		);
	}
	parts.push("In addition to the tools above, you may have access to other custom tools depending on the project.");
	return parts.join("\n\n");
}

/** 工具 schema 条目（发给模型的 function-calling 工具定义的最小字段）。 */
export interface ToolSchemaEntry {
	name: string;
	description?: string;
	parameters?: unknown;
}

/** 工具 schema 只读文本（设置面板「查看当前完整提示词」里展示发给模型的完整
 *  工具定义：name + description + parameters JSON Schema）。 */
export function buildToolsSchemaText(tools: ToolSchemaEntry[]): string {
	if (tools.length === 0) return "";
	return tools
		.map((t) => {
			const lines = [`## ${t.name}`];
			if (t.description && t.description.trim()) lines.push(t.description.trim());
			lines.push("", "Parameters (JSON Schema):", JSON.stringify(t.parameters ?? {}, null, 2));
			return lines.join("\n");
		})
		.join("\n\n");
}

/** 计算每个 token 的自动内容（无覆盖时的展开值）。 */
export function resolveSectionTexts(inputs: PromptComposerInputs): Record<PromptToken, string> {
	const cwd = inputs.cwd.replace(/\\/g, "/");
	const lang: ServerLang = inputs.lang ?? "en";
	// soul：用户 SYSTEM.md 优先；无则按 lang 选内置默认（调用方自定义的 builtinSoul 原样保留）。
	let soul = inputs.systemPromptFile?.trim() ? inputs.systemPromptFile : inputs.builtinSoul;
	if (lang === "zh" && soul === BUILTIN_SOUL) soul = BUILTIN_SOUL_ZH;
	else if (soul === BUILTIN_SOUL)
		soul = getServerBlock(lang, "prompt.soul", BUILTIN_SOUL_ZH.split("\n"), BUILTIN_SOUL.split("\n")).join("\n");
	return {
		soul,
		tools: buildToolsText(inputs, lang),
		guidelines: buildGuidelinesText(inputs),
		pi_docs: buildPiDocsText(inputs.piReadme, inputs.piDocs, inputs.piExamples, lang),
		append: inputs.appendFiles.join("\n\n"),
		persona: inputs.windowsPersona,
		terminal: inputs.terminalGuidance,
		markers: inputs.markersGuidance,
		context: buildContextText(inputs.contextFiles, lang),
		skills: buildSkillsText(inputs.skills, lang, inputs.skillsFullText ?? false),
		cwd: `Current working directory: ${cwd}`,
	};
}

/** 渲染模板：{{token}} → 覆盖文本（有）或自动内容（无/空覆盖）；未知名 token
 *  保留原文；没有 content 的 token 展开为空串。 */
export function renderPromptTemplate(
	template: string,
	texts: Record<string, string>,
	overrides: Record<string, string> | undefined,
): string {
	return effectiveTemplate(template).replace(TOKEN_RE, (full, name: string) => {
		const ov = overrideOf(overrides, name);
		if (ov) return ov;
		return Object.prototype.hasOwnProperty.call(texts, name) ? (texts[name] ?? "") : full;
	});
}

/** 用默认模板渲染（不覆盖）——等价于「恢复默认」后的成品。 */
export function renderDefaultPrompt(texts: Record<string, string>): string {
	return renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, texts, undefined);
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

/** 粗略 token 估算（设置面板预览用，非精确分词，无 tokenizer 依赖）：
 *  CJK 字符（汉字/假名/谚文）≈ 1 token/字，其余字符 ≈ 1 token / 4 字符。 */
export function estimatePromptTokens(text: string): number {
	if (!text) return 0;
	const cjk = text.match(CJK_RE)?.length ?? 0;
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** 把「早前扩展改过的提示词」拆成 SDK 原始提示词 + 扩展的首尾增补。
 *  before_agent_start 是链式的：我们是最后一个 handler，返回 systemPrompt 等于
 *  forceSystemPrompt 整体替换，会把别的扩展（如注入 <invoked_skill> 的）写进去的
 *  内容一起丢掉。只要原始提示词还原样嵌在里面（纯前置/后置增补），就能把增补摘出来
 *  重新套回我们的渲染结果上。摘不出来（中间插入 / 被整体替换）时返回 pre/post 为空、
 *  core 为当前文本 —— 调用方退回今天的行为，绝不把整段提示词翻倍。 */
export function splitExtensionWrap(baseline: string, current: string): { pre: string; core: string; post: string } {
	const at = baseline ? current.indexOf(baseline) : -1;
	if (at === -1) return { pre: "", core: current, post: "" };
	return { pre: current.slice(0, at), core: baseline, post: current.slice(at + baseline.length) };
}
