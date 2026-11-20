import { pick, type ServerLang } from "./i18n.js";

/**
 * 内置默认提示词配置的来源顺序（= 设置面板的行顺序 = DEFAULT_PROMPT_TEMPLATE 的拼装顺序）。
 * 与出厂默认一致：人格 → 项目上下文 → 工具 → 行内标记引导 → 技能 → 工作目录 → 追加段 → 插件开发指南（默认停用）。
 */
export const PROMPT_TOKENS = ["soul", "context", "tools", "markers", "skills", "cwd", "append", "plugin_dev"] as const;

export const READONLY_PROMPT_SOURCES = ["tools", "markers", "plugin_dev", "context", "skills", "cwd"] as const;

export type PromptToken = (typeof PROMPT_TOKENS)[number];

export const DEFAULT_PROMPT_DISABLED: string[] = ["plugin_dev"];

export function isReadonlyPromptSource(token: string): boolean {
	return (READONLY_PROMPT_SOURCES as readonly string[]).includes(token);
}

/**
 * 已下线的历史来源：
 * - `{{terminal}}`（终端工具引导）、`{{persona}}`（Windows 约束）；
 * - `{{guidelines}}`（行为准则：工具 promptGuidelines 汇总）、`{{pi_docs}}`（pi 文档指引）。
 * 老模板/老预设里残留这些 token 时渲染为空——不留字面量，也不复活该段文本。
 *
 * `{{persona}}` 下线理由：Windows / 远程工作区约束由宿主在 append 段无条件注入（`WINDOWS_PERSONA`），
 * 再挂一个可开关 token 只会让同一段文字注入两遍；设置面板也不该让用户去「启用」平台安全约束。
 * `{{guidelines}}` / `{{pi_docs}}` 下线理由：内置默认提示词配置不再输出这两段（产品决定），
 * 留空渲染以抵消存量模板里的引用，避免 `{{guidelines}}` 字面量直接漏进提示词。
 */
export const LEGACY_PROMPT_TOKENS: readonly string[] = ["terminal", "persona", "guidelines", "pi_docs"];

export function isLegacyPromptToken(token: string): boolean {
	return LEGACY_PROMPT_TOKENS.includes(token);
}

/** 是否仍是当前在册的来源（存量设置里的已下线来源用这个判定剔除）。 */
export function isPromptToken(token: string): boolean {
	return (PROMPT_TOKENS as readonly string[]).includes(token);
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
	pluginDocs?: string;
	pluginSdk?: string;
	pluginsDir?: string;
	appendFiles: string[];
	markersGuidance: string;
	contextFiles: { path: string; content: string }[];
	skills: { name: string; description: string; filePath: string; content?: string }[];
	skillsFullText?: readonly string[];
	skillsCatalogMaxDesc?: number;
	skillsCatalogShowLocation?: boolean;
	skillsCatalogBudget?: number;
	lang?: ServerLang;
}

/**
 * 内置默认人格（= 出厂默认提示词配置的 {{soul}} 自动内容）：六条工程准则，**纯英文**。
 * 所有界面语言共用同一份：不做中文对照版、也不走 locales 翻译（旧的单行 `prompt.soul` 已清掉）。
 * 守卫：tests/unit/prompt-composer.test.ts。
 */
export const BUILTIN_SOUL = [
	"# Core Engineering Principles",
	"- **Think First, Zero Rework**: settle boundary conditions, data flow and side effects before writing code; lock the approach down first.",
	"- **Root-Cause Over Patches**: never patch a symptom. Locate the architectural or logic root cause and fix it cleanly at the lowest layer.",
	"- **Pragmatic Modernity**: prefer modern, community-proven practices and mainstream open-source solutions (lean on the mature GitHub ecosystem), balancing cutting-edge efficiency with system robustness.",
	"- **KISS & High Cohesion**: keep the architecture minimal, cohesive and loosely coupled. No over-engineering in pursuit of formal perfection.",
	"- **Scoped Refactoring**: keep code clean as you go, but confine refactors to the modules this task touches; never break stable interfaces.",
	"- **Dispatch On Clear Boundaries**: when boundaries are enumerable, acceptance criteria executable, file sets non-overlapping, interfaces frozen, and 2+ units can run in parallel, split work into contract-bound tasks; each subtask gets only the minimal context and permissions it needs, returns executable evidence, and interface changes merge back at the dispatcher.",
].join("\n");

/** 与内置默认逐字相同的 soul 文案（存量覆盖归一用：等于它就没有覆盖的必要）。 */
export const BUILTIN_SOUL_TEXTS: readonly string[] = [BUILTIN_SOUL];

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

const TOOLS_TAIL =
	"In addition to the tools above, you may have access to other custom tools depending on the project.";

function buildToolsText(inputs: PromptComposerInputs): string {
	const listed = inputs.catalogTools ?? inputs.selectedTools;
	if (inputs.lazy) {
		// 按需目录：只列名单工具（常驻工具 schema 已全量下发，不重复列）。
		// 名单为空 = 没有任何工具可加载，整段（目录 + load_tools 说明 + 尾巴）都不输出。
		if (listed.length === 0) return "";
		const onDemandList = listed
			.map((n) => {
				const sig = inputs.toolSignatures?.[n] ? ` ${inputs.toolSignatures[n]}` : "";
				const snippet = inputs.toolSnippets[n];
				return `- ${n}:${sig}${snippet ? ` ${snippet}` : ""}`;
			})
			.join("\n");
		// 纯英文精简：工具段不进双语（与工具提示词口径一致）。
		return [
			`On-demand tools (schema not attached — call \`load_tools\` with the names first):\n${onDemandList}`,
			TOOLS_TAIL,
		].join("\n\n");
	}
	const visible = listed.filter((n) => !!inputs.toolSnippets[n]);
	if (visible.length === 0) return "";
	const toolsList = visible
		.map((n) => {
			const sig = inputs.toolSignatures?.[n] ? ` ${inputs.toolSignatures[n]}` : "";
			return `- ${n}:${sig} ${inputs.toolSnippets[n]}`;
		})
		.join("\n");
	return [`Available tools:\n${toolsList}`, TOOLS_TAIL].join("\n\n");
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
	soul = `${soul}\nBe concise in your responses\nShow file paths clearly when working with files`;
	return {
		soul,
		tools: buildToolsText(inputs),
		append: inputs.appendFiles.join("\n\n"),
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
		if (isLegacyPromptToken(name)) return "";
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
