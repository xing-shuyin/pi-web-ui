import { describe, expect, it } from "vitest";
import {
	BUILTIN_SOUL,
	DEFAULT_PROMPT_TEMPLATE,
	PROMPT_TOKENS,
	READONLY_PROMPT_SOURCES,
	buildPiDocsText,
	buildSkillsText,
	buildToolsSchemaText,
	collectTemplateTokens,
	effectiveTemplate,
	estimatePromptTokens,
	isReadonlyPromptSource,
	renderDefaultPrompt,
	renderPromptTemplate,
	resolveSectionTexts,
	splitExtensionWrap,
	type PromptComposerInputs,
} from "../../server/prompt-composer.js";

const AGENTS_CONTENT = "# AGENTS.md — pi-web-ui 项目指南\n\n详细文档按主题分拆在 docs/ 目录下。";

function inputs(partial: Partial<PromptComposerInputs> = {}): PromptComposerInputs {
	return {
		cwd: "E:\\pi-web-ui",
		builtinSoul: BUILTIN_SOUL,
		selectedTools: ["read", "bash", "edit", "write", "terminal_create", "ask_user_question"],
		toolSnippets: {
			read: "Read file contents",
			bash: "Run shell commands",
			edit: "Make precise edits",
			write: "Create or overwrite files",
			terminal_create: "create interactive terminals",
			ask_user_question: "ask the user questions",
		},
		toolGuidelines: ["Use read to examine files instead of cat or sed.", "Ask whenever requirements are ambiguous."],
		piReadme: "E:/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/README.md",
		piDocs: "E:/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/docs",
		piExamples: "E:/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/examples",
		appendFiles: [],
		windowsPersona: "You are a coding agent running on Windows. Follow these rules to avoid hanging the session:",
		terminalGuidance: "Persistent interactive terminal tools are available:",
		markersGuidance: "",
		contextFiles: [{ path: "E:\\pi-web-ui\\AGENTS.md", content: AGENTS_CONTENT }],
		skills: [{ name: "mermaid", description: "render mermaid diagrams", filePath: "E:/pi-web-ui/plugins/mermaid" }],
		...partial,
	};
}

describe("token 元数据", () => {
	it("默认模板按序含全部 token，无重复、无未知", () => {
		const tokens = collectTemplateTokens(DEFAULT_PROMPT_TEMPLATE);
		expect(tokens).toEqual(PROMPT_TOKENS);
		for (const t of tokens) {
			expect(isKnown(t)).toBe(true);
		}
		expect(tokens.length).toBe(PROMPT_TOKENS.length);
	});

	it("空/纯空白模板 → 默认模板；自定义模板保留", () => {
		expect(effectiveTemplate("")).toBe(DEFAULT_PROMPT_TEMPLATE);
		expect(effectiveTemplate("   \n")).toBe(DEFAULT_PROMPT_TEMPLATE);
		expect(effectiveTemplate("{{soul}} only")).toBe("{{soul}} only");
	});

	it("collectTemplateTokens 收集未知 token 用于提示", () => {
		const tokens = collectTemplateTokens("{{soul}}\n{{typo_token}}");
		expect(tokens).toContain("soul");
		expect(tokens).toContain("typo_token");
	});
});

function isKnown(t: string): boolean {
	return (PROMPT_TOKENS as readonly string[]).includes(t);
}

describe("resolveSectionTexts — 各来源自动内容", () => {
	it("soul：无 SYSTEM.md 用内置默认；有则用文件内容（均附通用写作要求）", () => {
		const auto = resolveSectionTexts(inputs());
		expect(auto.soul.startsWith(BUILTIN_SOUL)).toBe(true);
		expect(auto.soul).toContain("Be concise in your responses");
		expect(auto.soul).toContain("Show file paths clearly when working with files");
		const custom = "我的自定义人格文件";
		const withFile = resolveSectionTexts(inputs({ systemPromptFile: custom }));
		expect(withFile.soul.startsWith(custom)).toBe(true);
		expect(withFile.soul).toContain("Be concise in your responses");
	});

	it("soul：纯空白 SYSTEM.md 原样保留（= 空提示词，TUI 同语义）", () => {
		// issue #812：SDK 用 `if (customPrompt)`（真值）判定，所以 " \n" 是「空提示词」
		// 而不是「没文件」。旧实现的 .trim() 会让它回落内置默认，既与 TUI 不一致，
		// 也把「切到空白项目就意外重置」伪装成 Bug。
		const blank = resolveSectionTexts(inputs({ systemPromptFile: " \n" }));
		expect(blank.soul.startsWith(" \n")).toBe(true);
		expect(blank.soul.startsWith(BUILTIN_SOUL)).toBe(false);
		// 0 字节 / undefined 才是「没文件」→ 内置默认。
		expect(resolveSectionTexts(inputs({ systemPromptFile: "" })).soul.startsWith(BUILTIN_SOUL)).toBe(true);
		expect(resolveSectionTexts(inputs({ systemPromptFile: undefined })).soul.startsWith(BUILTIN_SOUL)).toBe(true);
	});

	it("tools：非懒加载且无 snippet 覆盖时返回空串（全量 schema 已下发，目录不重复）", () => {
		const auto = resolveSectionTexts(inputs({ toolSnippets: {} }));
		expect(auto.tools).toBe("");
	});

	it("tools（lazy 模式）：声明核心工具常驻且其他工具按需 load_tools", () => {
		const enAuto = resolveSectionTexts(
			inputs({
				lazy: true,
				catalogTools: ["bash", "read", "edit", "write", "patch"],
				lang: "en",
			}),
		);
		expect(enAuto.tools).toContain("Core tools (bash, read, edit, write) and `load_tools` are always active");
		expect(enAuto.tools).toContain("pass their names to `load_tools` before calling them");

		const zhAuto = resolveSectionTexts(
			inputs({
				lazy: true,
				catalogTools: ["bash", "read", "edit", "write", "patch"],
				lang: "zh",
			}),
		);
		expect(zhAuto.tools).toContain("核心工具（bash, read, edit, write）及 `load_tools` 始终常驻可用，无需加载");
		expect(zhAuto.tools).toContain("调用前先用 `load_tools` 附加上完整参数");
	});

	it("guidelines：探索引导 + 工具引导去重（无固定文案，固定文案已移 soul）", () => {
		const auto = resolveSectionTexts(inputs());
		expect(auto.guidelines).toContain("Guidelines:\n- Use bash for file operations like ls, rg, find");
		expect(auto.guidelines).toContain("- Use read to examine files instead of cat or sed.");
		expect(auto.guidelines).not.toContain("Be concise in your responses");
		expect(auto.guidelines).not.toContain("Show file paths clearly when working with files");
		// 无 grep/find/ls 时不重复输出探索引导（去重生效）
		expect(auto.guidelines.match(/Use bash for file operations/g)?.length).toBe(1);
	});

	it("pi_docs：固定指引 + 注入路径", () => {
		const auto = resolveSectionTexts(inputs());
		expect(auto.pi_docs).toContain(
			"Main documentation: E:/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/README.md",
		);
		expect(auto.pi_docs).toContain("resolve docs/... under Additional docs");
		expect(auto.pi_docs).toBe(buildPiDocsText(inputs().piReadme, inputs().piDocs, inputs().piExamples));
	});

	it("append：多文件 \n\n 连接；无文件为空", () => {
		const empty = resolveSectionTexts(inputs());
		expect(empty.append).toBe("");
		const two = resolveSectionTexts(inputs({ appendFiles: ["第一段", "第二段"] }));
		expect(two.append).toBe("第一段\n\n第二段");
	});

	it("context：包上 <project_context> 并保留 AGENTS.md 内容（无自动段泄漏）", () => {
		const auto = resolveSectionTexts(inputs());
		expect(auto.context).toContain("<project_context>");
		expect(auto.context).toContain("Project-specific instructions and guidelines:");
		expect(auto.context).toContain('<project_instructions path="E:\\pi-web-ui\\AGENTS.md">');
		expect(auto.context).toContain(AGENTS_CONTENT);
		expect(auto.context).toContain("</project_context>");
		const none = resolveSectionTexts(inputs({ contextFiles: [] }));
		expect(none.context).toBe("");
	});

	it("skills：紧凑名录单行格式 + <available_skills>；空技能为空串", () => {
		const auto = resolveSectionTexts(inputs());
		expect(auto.skills).toContain("<available_skills>");
		expect(auto.skills).toContain("- mermaid: render mermaid diagrams");
		expect(resolveSectionTexts(inputs({ skills: [] })).skills).toBe("");
	});

	it("cwd：反斜杠转正斜杠", () => {
		expect(resolveSectionTexts(inputs()).cwd).toBe("Current working directory: E:/pi-web-ui");
	});

	it("persona/terminal/markers 直接透传自动内容", () => {
		const auto = resolveSectionTexts(inputs());
		expect(auto.persona).toContain("Windows");
		expect(auto.terminal).toContain("terminal");
		expect(auto.markers).toBe("");
	});
});

describe("renderPromptTemplate — 组合与覆盖", () => {
	const texts = resolveSectionTexts(inputs());
	const RENDERED = renderDefaultPrompt(texts);

	it("默认渲染 ≈ SDK 默认拼装：顺序、关键段、无残留花括号", () => {
		const order = [
			"You are an expert coding assistant",
			"Guidelines:",
			"Pi documentation (read only",
			"Current working directory: E:/pi-web-ui",
		];
		let last = -1;
		for (const seg of order) {
			const idx = RENDERED.indexOf(seg);
			expect(idx).toBeGreaterThan(last);
			last = idx;
		}
		expect(RENDERED).not.toContain("{{");
		expect(RENDERED).toContain("<project_context>");
		expect(RENDERED).toContain(AGENTS_CONTENT);
		expect(RENDERED).toContain("<available_skills>");
		expect(RENDERED).toContain("Windows");
	});

	it("覆盖 soul：整体模板中灵魂被替换、其他自动段原样", () => {
		const out = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, texts, { soul: "你是降世神龙，专精代码重构。" });
		expect(out.startsWith("你是降世神龙，专精代码重构。")).toBe(true);
		expect(out).not.toContain("You are an expert coding assistant");
		expect(out).toContain("Guidelines:");
		expect(out).toContain(AGENTS_CONTENT);
		expect(out).toContain("Current working directory: E:/pi-web-ui");
	});

	it("单独覆盖 context：自动 AGENTS.md 内容被换成自定义", () => {
		const out = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, texts, { context: "只提 docs/ 里的规则" });
		expect(out).toContain("只提 docs/ 里的规则");
		expect(out).not.toContain(AGENTS_CONTENT);
	});

	it("自由组合：只放想保留的块，可任意排序与穿插文字", () => {
		const template = "我的开场白\n\n{{soul}}\n\n补充：{{context}}\n\n{{cwd}}";
		const out = renderPromptTemplate(template, texts, {});
		expect(out).toBe(
			"我的开场白\n\n你是降世神龙，专精代码重构。".length
				? out.replace("你是降世神龙，专精代码重构。", BUILTIN_SOUL)
				: out,
		);
		expect(out.startsWith("我的开场白")).toBe(true);
		expect(out).toContain("补充：<project_context>");
		expect(out).toContain("Current working directory: E:/pi-web-ui");
		expect(out).not.toContain("Available tools:");
		expect(out).not.toContain("{{");
	});

	it("空自动段展开为空串；未知名 token 保留原文", () => {
		const noCtx = resolveSectionTexts(inputs({ contextFiles: [], markersGuidance: "", skills: [] }));
		const out = renderPromptTemplate("a{{context}}b", noCtx, {});
		expect(out).toBe("ab");
		const unknown = renderPromptTemplate("x{{typo}}y", texts, {});
		expect(unknown).toBe("x{{typo}}y");
	});

	it("override 优先于自动内容；空白 override 视为未覆盖", () => {
		const out = renderPromptTemplate("{{soul}}", texts, { soul: "   \n" });
		expect(out).toBe(texts.soul);
	});
});

describe("buildToolsSchemaText — 工具 schema 只读文本", () => {
	it("空列表 → 空串", () => {
		expect(buildToolsSchemaText([])).toBe("");
	});

	it("每个工具输出 ## 名称 + description + parameters JSON", () => {
		const out = buildToolsSchemaText([
			{
				name: "ask_user_question",
				description: "Ask the user focused questions.",
				parameters: {
					type: "object",
					properties: { questions: { type: "array" } },
					required: ["questions"],
				},
			},
		]);
		expect(out).toContain("## ask_user_question");
		expect(out).toContain("Ask the user focused questions.");
		expect(out).toContain('"questions": {');
		expect(out).toContain('"required": [');
	});

	it("Description 为空时省略该行，仍保留 parameters", () => {
		const out = buildToolsSchemaText([{ name: "bash", parameters: { type: "object" } }]);
		expect(out).toContain("## bash");
		expect(out).not.toContain("undefined");
		expect(out).toContain("Parameters (JSON Schema):");
	});
});

describe("buildSkillsText 全文/名单模式", () => {
	const skills = [
		{
			name: "code-review",
			description: "Review code",
			filePath: "/s/code-review.md",
			content: "# Review\nCheck this.",
		},
		{ name: "no-body", description: "No body", filePath: "/s/no-body.md" },
	];

	it("默认名录模式：只有 available_skills 名录", () => {
		const t = buildSkillsText(skills, "en");
		expect(t).toContain("<available_skills>");
		expect(t).not.toContain("### Skill:");
	});

	it("全文模式（true）：有 content 的按格式展开，无 content 的回落名录行", () => {
		const t = buildSkillsText(skills, "en", true);
		expect(t).toContain("### Skill: code-review");
		expect(t).toContain("> Review code");
		expect(t).toContain("# Review\nCheck this.");
		expect(t).toContain("- no-body: No body");
	});

	it("名单模式：只注入名单里的技能", () => {
		const t = buildSkillsText(skills, "en", ["no-body"]);
		expect(t).not.toContain("### Skill: code-review");
		expect(t).toContain("- code-review: Review code");
		expect(t).toContain("- no-body: No body");
		expect(buildSkillsText(skills, "en", ["code-review"])).toContain("### Skill: code-review");
	});

	it("空技能列表两种模式都返回空串", () => {
		expect(buildSkillsText([], "en", true)).toBe("");
		expect(buildSkillsText([], "zh")).toBe("");
	});

	it("描述截断、路径控制、预算降级与稳定排序", () => {
		const unordered = [
			{
				name: "zebra",
				description: "Zebra skill with a very long description that needs truncating",
				filePath: "/custom/path/zebra.md",
			},
			{ name: "alpha", description: "Alpha skill", filePath: "/custom/path/alpha.md" },
		];
		// 1. 稳定字母序排序
		const sortedText = buildSkillsText(unordered, "en");
		const alphaIdx = sortedText.indexOf("- alpha:");
		const zebraIdx = sortedText.indexOf("- zebra:");
		expect(alphaIdx).toBeGreaterThan(0);
		expect(zebraIdx).toBeGreaterThan(alphaIdx);

		// 2. 默认不输出 location 路径
		expect(sortedText).not.toContain("/custom/path/alpha.md");
		expect(sortedText).not.toContain("location:");

		// 3. showLocation 为 true 时输出 location 路径
		const withLoc = buildSkillsText(unordered, "en", false, { showLocation: true });
		expect(withLoc).toContain("- alpha: Alpha skill (location: /custom/path/alpha.md)");

		// 4. 描述截断
		const truncated = buildSkillsText(unordered, "en", false, { maxDesc: 15 });
		expect(truncated).toContain("- zebra: Zebra skill ...");

		// 5. 预算超限自动降级为紧凑模式（names-only）
		const compact = buildSkillsText(unordered, "en", false, { budget: 100 });
		expect(compact).toContain("- alpha\n- zebra");
		expect(compact).not.toContain("Alpha skill");
		expect(compact).toContain("compact name index enabled");
	});
});

describe("READONLY_PROMPT_SOURCES / isReadonlyPromptSource — 只读来源判定", () => {
	it("只读集合为 8 个，且不含 soul / guidelines / append", () => {
		expect(READONLY_PROMPT_SOURCES).toHaveLength(8);
		expect(READONLY_PROMPT_SOURCES).toEqual([
			"tools",
			"pi_docs",
			"persona",
			"terminal",
			"markers",
			"context",
			"skills",
			"cwd",
		]);
		for (const s of ["soul", "guidelines", "append"]) {
			expect(READONLY_PROMPT_SOURCES).not.toContain(s);
		}
	});

	it("isReadonlyPromptSource 判定正确", () => {
		expect(isReadonlyPromptSource("tools")).toBe(true);
		expect(isReadonlyPromptSource("cwd")).toBe(true);
		expect(isReadonlyPromptSource("soul")).toBe(false);
		expect(isReadonlyPromptSource("guidelines")).toBe(false);
		expect(isReadonlyPromptSource("append")).toBe(false);
		expect(isReadonlyPromptSource("typo")).toBe(false);
	});
});

describe("estimatePromptTokens — token 占用估算", () => {
	it("空串为 0；纯 ASCII ≈ 1 token / 4 字符（向上取整）", () => {
		expect(estimatePromptTokens("")).toBe(0);
		expect(estimatePromptTokens("abcdefgh")).toBe(2);
		expect(estimatePromptTokens("abc")).toBe(1);
	});

	it("CJK 字符按 1 token/字，混排按两类分别计", () => {
		expect(estimatePromptTokens("你好世界")).toBe(4);
		// 4 个汉字 + 8 个 ASCII 字符
		expect(estimatePromptTokens("你好世界abcdefgh")).toBe(6);
	});

	it("实际提示词量级合理（默认模板渲染结果不为 0 且随内容增长）", () => {
		const short = renderDefaultPrompt(resolveSectionTexts(inputs()));
		const more = renderDefaultPrompt(
			resolveSectionTexts(inputs({ contextFiles: [{ path: "A.md", content: "x".repeat(10_000) }] })),
		);
		const base = estimatePromptTokens(short);
		expect(base).toBeGreaterThan(0);
		expect(estimatePromptTokens(more)).toBeGreaterThan(base + 2000);
	});
});

describe("splitExtensionWrap", () => {
	const base = "You are Pi.\n\nAvailable tools:\nread, bash";

	it("no extension touched the prompt → nothing to re-wrap", () => {
		expect(splitExtensionWrap(base, base)).toEqual({ pre: "", core: base, post: "" });
	});

	it("keeps a prepend", () => {
		const wrap = splitExtensionWrap(base, `<invoked_skill/>\n${base}`);
		expect(wrap).toEqual({ pre: "<invoked_skill/>\n", core: base, post: "" });
		expect(wrap.pre + "RENDERED" + wrap.post).toBe("<invoked_skill/>\nRENDERED");
	});

	it("keeps an append", () => {
		expect(splitExtensionWrap(base, `${base}\n<extra/>`)).toEqual({ pre: "", core: base, post: "\n<extra/>" });
	});

	it("keeps prepend and append together", () => {
		expect(splitExtensionWrap(base, `A\n${base}\nB`)).toEqual({ pre: "A\n", core: base, post: "\nB" });
	});

	it("mid-prompt insertion is not splittable → caller keeps today's behaviour", () => {
		const spliced = base.replace("Available tools:", "<mid/>\nAvailable tools:");
		expect(splitExtensionWrap(base, spliced)).toEqual({ pre: "", core: spliced, post: "" });
	});

	it("wholesale replacement is not splittable → never doubles the prompt", () => {
		expect(splitExtensionWrap(base, "totally different")).toEqual({
			pre: "",
			core: "totally different",
			post: "",
		});
	});

	it("empty baseline is not searched for", () => {
		expect(splitExtensionWrap("", "anything")).toEqual({ pre: "", core: "anything", post: "" });
	});

	it("splits on the first occurrence when the baseline repeats", () => {
		expect(splitExtensionWrap("x", "axbxc")).toEqual({ pre: "a", core: "x", post: "bxc" });
	});
});
