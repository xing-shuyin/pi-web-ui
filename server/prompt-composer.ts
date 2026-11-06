import { getServerBlock, pick, type ServerLang } from "./i18n.js";

export const PROMPT_TOKENS = [
	"soul",
	"tools",
	"guidelines",
	"pi_docs",
	"append",
	"persona",
	"terminal",
	"markers",
	"plugin_dev",
	"context",
	"skills",
	"cwd",
] as const;

export const READONLY_PROMPT_SOURCES = [
	"tools",
	"pi_docs",
	"plugin_dev",
	"persona",
	"terminal",
	"markers",
	"context",
	"skills",
	"cwd",
] as const;

export type PromptToken = (typeof PROMPT_TOKENS)[number];

export const DEFAULT_PROMPT_DISABLED: string[] = ["plugin_dev"];

export function isReadonlyPromptSource(token: string): boolean {
	return (READONLY_PROMPT_SOURCES as readonly string[]).includes(token);
}

export const DEFAULT_PROMPT_TEMPLATE = PROMPT_TOKENS.map((t) => `{{${t}}}`).join("\n\n");

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function collectTemplateTokens(template: string): string[] {
	const out: string[] = [];
	for (const m of template.matchAll(TOKEN_RE)) {
		if (!out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

export function effectiveTemplate(template: string): string {
	const t = (template ?? "").trim();
	return t || DEFAULT_PROMPT_TEMPLATE;
}

export function overrideOf(overrides: Record<string, string> | undefined, token: string): string {
	const v = overrides?.[token];
	return v && v.trim() ? v : "";
}

export interface PromptComposerInputs {
	cwd: string;
	systemPromptFile?: string;
	builtinSoul: string;
	selectedTools: string[];
	lazy?: boolean;
	catalogTools?: string[];
	toolSnippets: Record<string, string>;
	toolSignatures?: Record<string, string>;
	toolGuidelines: string[];
	piReadme: string;
	piDocs: string;
	piExamples: string;
	pluginDocs?: string;
	pluginSdk?: string;
	pluginsDir?: string;
	appendFiles: string[];
	windowsPersona: string;
	terminalGuidance: string;
	markersGuidance: string;
	contextFiles: { path: string; content: string }[];
	skills: { name: string; description: string; filePath: string; content?: string }[];
	skillsFullText?: readonly string[];
	skillsCatalogMaxDesc?: number;
	skillsCatalogShowLocation?: boolean;
	skillsCatalogBudget?: number;
	lang?: ServerLang;
}

export const BUILTIN_SOUL =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export const BUILTIN_SOUL_ZH =
	"你是运行在 pi（一个编码智能体框架）中的专业编码助手。你通过读取文件、执行命令、编辑代码和新建文件来帮助用户。";

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

export function buildPluginDevText(inputs: PromptComposerInputs, lang: ServerLang = "en"): string {
	const docsPath = inputs.pluginDocs || "docs/architecture-plugins.md";
	const sdkPath = inputs.pluginSdk || "plugin-sdk";
	const targetDir = inputs.pluginsDir || "<dataDir>/plugins";
	if (lang === "zh") {
		return [
			"pi-web-ui 插件开发指南（仅当用户明确要求编写、修改或调试 pi-web-ui 插件时遵循）：",
			`- 架构与 API 详细文档：${docsPath}（包含 Manifest 规范、生命周期、34 个 UI Slots、宿主方法表与权限声明，写代码前请先用 read 查阅此文档）`,
			`- 插件 SDK 源码与类型：${sdkPath}（含 index.mjs、client-utils.mjs、index.d.ts）`,
			`- 插件唯一落盘目录：${targetDir}/<plugin-id>/（插件必须创建在此数据目录下，绝不可写在当前工作区 cwd 或程序只读安装目录）`,
			"- 双 SDK 副本关键规则：宿主对浏览器只暴露 /plugins/<id>/client/* 静态文件；服务端入口从 <plugin>/sdk/index.mjs 导入，客户端入口（client/entry.mjs）必须从 <plugin>/client/sdk/index.mjs 导入且仅能使用 ./sdk/index.mjs 相对导入，禁止相对路径越出 client/",
			"- 基础文件结构：",
			"  1. manifest.json（定义 id, name, version, capabilities, permissions, ui 贡献点）",
			'  2. index.mjs（服务端入口：import { definePlugin } from "./sdk/index.mjs"; export default definePlugin({ async activate(host) { ... } })）',
			'  3. client/entry.mjs（若声明了界面视图：import { defineView } from "./sdk/index.mjs"; export default defineView({ mount(el, ctx) { ... } })）',
			"- 生成脚手架：若环境有 pi-web-ui CLI 可运行 `pi-web-ui plugin create <id> --template <minimal|ui-slot|agent-tool|renderer>`；若无 CLI（如桌面端）请直接用 write 在目标目录写入上述文件结构并从 SDK 复制必要模块",
			"- 生效方式：写入文件后，提示用户在「设置 - 插件」面板点击重扫刷新，或重启应用即可加载新插件",
		].join("\n");
	}
	return [
		"pi-web-ui Plugin Development Guide (follow only when asked to create, modify, or debug pi-web-ui plugins):",
		`- Architecture & API Docs: ${docsPath} (defines Manifest schema, lifecycles, 34 UI Slots, host methods; read before writing code)`,
		`- Plugin SDK Source & Types: ${sdkPath} (contains index.mjs, client-utils.mjs, index.d.ts)`,
		`- Target Plugin Directory: ${targetDir}/<plugin-id>/ (MUST be written under the host data directory, NEVER in project cwd or app install dir)`,
		"- Dual SDK Copy Rule: The host exposes only /plugins/<id>/client/* to the browser; server imports from <plugin>/sdk/index.mjs, while client entry (client/entry.mjs) MUST import from <plugin>/client/sdk/index.mjs and cannot cross outside client/",
		"- Minimal Structure:",
		"  1. manifest.json (declares id, name, version, capabilities, permissions, ui contributions)",
		'  2. index.mjs (server entry: import { definePlugin } from "./sdk/index.mjs"; export default definePlugin({ async activate(host) { ... } }))',
		'  3. client/entry.mjs (view entry: import { defineView } from "./sdk/index.mjs"; export default defineView({ mount(el, ctx) { ... } }))',
		"- Scaffolding: Use `pi-web-ui plugin create <id> --template <minimal|ui-slot|agent-tool|renderer>` if the CLI is available; otherwise write files directly to the target directory and copy SDK files",
		"- Activation: Once files are written, advise the user to click Rescan in Settings -> Plugins or restart the app",
	].join("\n");
}

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
	return `${pick(lang, "指导原则：", "Guidelines:", "prompt.guidelines.title")}\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

export interface BuildSkillsTextOptions {
	maxDesc?: number;
	showLocation?: boolean;
	budget?: number;
}

export function buildSkillsText(
	skills: PromptComposerInputs["skills"],
	lang: ServerLang = "en",
	fullText: boolean | readonly string[] = false,
	options?: BuildSkillsTextOptions,
): string {
	const visible = skills
		.filter((s) => !(s as { disableModelInvocation?: boolean }).disableModelInvocation)
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));
	if (visible.length === 0) return "";

	const maxDesc = options?.maxDesc !== undefined ? options.maxDesc : 250;
	const showLocation = options?.showLocation ?? false;
	const budget = options?.budget !== undefined ? options.budget : 20000;

	const formatDesc = (desc: string): string => {
		const singleLine = desc.replace(/[\r\n]+/g, " ").trim();
		if (maxDesc > 0 && singleLine.length > maxDesc) {
			return singleLine.length > 3 ? `${singleLine.slice(0, maxDesc - 3)}...` : singleLine.slice(0, maxDesc);
		}
		return singleLine;
	};

	const renderCatalog = (compact: boolean): string[] => {
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
		];

		if (compact) {
			lines.push(
				pick(
					lang,
					"（技能名录庞大已启用紧凑索引，仅显示名称。请使用 skill 工具按名称载入或查询）",
					"(Skill catalog is large; compact name index enabled. Use the skill tool to inspect or load by name.)",
					"prompt.skills.catalog.compact",
				),
			);
		}

		lines.push("", "<available_skills>");

		for (const skill of visible) {
			const inject = fullText === true || (Array.isArray(fullText) && fullText.includes(skill.name));
			if (inject && skill.content?.trim()) {
				lines.push(`### Skill: ${skill.name}`);
				if (skill.description.trim()) lines.push(`> ${skill.description.trim()}`);
				lines.push("", skill.content.trim(), "");
				continue;
			}

			if (compact) {
				lines.push(`- ${skill.name}`);
			} else {
				const d = formatDesc(skill.description);
				let line = `- ${skill.name}`;
				if (d) line += `: ${d}`;
				if (showLocation && skill.filePath) {
					line += ` (location: ${skill.filePath})`;
				}
				lines.push(line);
			}
		}
		lines.push("</available_skills>");
		return lines;
	};

	const standardLines = renderCatalog(false);
	const standardText = standardLines.join("\n");

	if (budget > 0 && standardText.length > budget) {
		return renderCatalog(true).join("\n");
	}

	return standardText;
}

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

function buildToolsText(inputs: PromptComposerInputs, lang: ServerLang): string {
	const listed = inputs.catalogTools ?? inputs.selectedTools;
	const visible = listed.filter((n) => !!inputs.toolSnippets[n]);
	if (!inputs.lazy && visible.length === 0) return "";
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

export interface ToolSchemaEntry {
	name: string;
	description?: string;
	parameters?: unknown;
}

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

export function resolveSectionTexts(inputs: PromptComposerInputs): Record<PromptToken, string> {
	const cwd = inputs.cwd.replace(/\\/g, "/");
	const lang: ServerLang = inputs.lang ?? "en";
	const soulSource = inputs.systemPromptFile;
	let soul = soulSource ? soulSource : inputs.builtinSoul;
	if (lang === "zh" && soul === BUILTIN_SOUL) soul = BUILTIN_SOUL_ZH;
	else if (soul === BUILTIN_SOUL)
		soul = getServerBlock(lang, "prompt.soul", BUILTIN_SOUL_ZH.split("\n"), BUILTIN_SOUL.split("\n")).join("\n");
	soul = `${soul}\nBe concise in your responses\nShow file paths clearly when working with files`;
	return {
		soul,
		tools: buildToolsText(inputs, lang),
		guidelines: buildGuidelinesText(inputs),
		pi_docs: buildPiDocsText(inputs.piReadme, inputs.piDocs, inputs.piExamples, lang),
		append: inputs.appendFiles.join("\n\n"),
		persona: inputs.windowsPersona,
		terminal: inputs.terminalGuidance,
		markers: inputs.markersGuidance,
		plugin_dev: buildPluginDevText(inputs, lang),
		context: buildContextText(inputs.contextFiles, lang),
		skills: buildSkillsText(inputs.skills, lang, inputs.skillsFullText ?? false, {
			maxDesc: inputs.skillsCatalogMaxDesc,
			showLocation: inputs.skillsCatalogShowLocation,
			budget: inputs.skillsCatalogBudget,
		}),
		cwd: `Current working directory: ${cwd}`,
	};
}

export function renderPromptTemplate(
	template: string,
	texts: Record<string, string>,
	overrides: Record<string, string> | undefined,
	disabled?: Set<string> | string[],
): string {
	const dis = disabled instanceof Set ? disabled : new Set(disabled ?? []);
	return effectiveTemplate(template).replace(TOKEN_RE, (full, name: string) => {
		if (dis.has(name)) return "";
		const ov = overrideOf(overrides, name);
		if (ov) return ov;
		return Object.prototype.hasOwnProperty.call(texts, name) ? (texts[name] ?? "") : full;
	});
}

export function renderDefaultPrompt(texts: Record<string, string>, disabled?: Set<string> | string[]): string {
	return renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, texts, undefined, disabled);
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

export function estimatePromptTokens(text: string): number {
	if (!text) return 0;
	const cjk = text.match(CJK_RE)?.length ?? 0;
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function splitExtensionWrap(baseline: string, current: string): { pre: string; core: string; post: string } {
	const at = baseline ? current.indexOf(baseline) : -1;
	if (at === -1) return { pre: "", core: current, post: "" };
	return { pre: current.slice(0, at), core: baseline, post: current.slice(at + baseline.length) };
}
