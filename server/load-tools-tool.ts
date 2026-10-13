// ---------------------------------------------------------------------------
// load-tools-tool.ts — 延迟加载模式下模型拉取工具 schema 的唯一入口。
// ---------------------------------------------------------------------------
// 背景：模型每轮都会拿到**全部活跃工具**的名字 + 完整参数 schema，几十个工具加起来
// 是几万字符的常驻开销（设置页「查看工具 schema」能看到了多少）。延迟加载把工具分成
// 两层：
//   - 常驻：核心工具（bash/read/edit/write）+ 本工具；
//   - 目录：其余工具只在系统提示词里以「名字 + 一行摘要」出现（见 prompt-composer 的
//     tool catalog 段）。
// 模型要用某个目录里的工具时先调本工具，那批工具才会被激活 —— SDK 的中途工具变更会
// 把新增工具以 defer_loading / tool_search 的形式注入（见 agent-session 的
// `_preparePromptAndToolLoadout`），不占首轮上下文。
//
// 与 skills 的 `skill` 工具同构：名录常驻、正文按需。区别只在「正文」是工具 schema。
//
// 文案约定：工具 definition（description/promptSnippet/promptGuidelines）纯英文；
// per-call 返回文本按 lang 走 pick(lang, zh, en, key)。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { LOAD_TOOLS_TOOL_NAME } from "./tool-manager.js";

/** 一条可加载工具（名字 + 一行摘要 + 完整描述/要点，后两者只在加载回执里给）。 */
export interface LoadableToolInfo {
	name: string;
	/** 系统提示词里已有的那一行摘要（回执用；缺失回落到描述首句）。 */
	summary?: string;
	/** 完整出厂描述（加载后 model 需要它才能正确调用）。 */
	description?: string;
	/** 工具的 promptGuidelines —— 延迟加载时**不进系统提示词**（进去会让提示词
	 *  随加载变化、打坏前缀缓存），改由加载回执带到对话里。 */
	guidelines?: string[];
}

/** 数据宿主（由 AgentService 实现：它才知道注册表、禁用名单与三道闸门）。 */
export interface LoadToolsHost {
	/** 当前**可以**加载的工具（已排除未知、用户禁用、预设屏蔽、当前闸门拦截、已加载）。 */
	listLoadable(): LoadableToolInfo[];
	/** 已加载（活跃）的工具名。 */
	listLoaded(): string[];
	/** 执行加载：返回实际加载的与拒绝的（拒绝带原因，模型能自行纠正）。 */
	load(names: string[]): { loaded: LoadableToolInfo[]; rejected: { name: string; reason: string }[] };
}

/** 单次最多加载多少（防模型一口气把整个目录塞回来）。 */
export const LOAD_TOOLS_MAX = 20;

function describe(t: LoadableToolInfo): string {
	const text = (t.description ?? t.summary ?? "").trim().split("\n")[0] ?? "";
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export function makeLoadToolsTool(host: LoadToolsHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: LOAD_TOOLS_TOOL_NAME,
		label: "Load tools",
		description:
			"Attach the full parameter schema of tools listed in the system prompt's tool catalog. " +
			"Tools whose schema is not loaded are shown there by name + one-line summary; load the ones you need " +
			"BEFORE calling them. Loaded tools stay available for the rest of the conversation.",
		promptSnippet: "load catalog tools you are about to use",
		promptGuidelines: [
			"When a task needs a tool that is only listed in the catalog (name + one-line summary, no schema yet), " +
				"call load_tools with its name first instead of guessing arguments",
			"Core tools (bash, read, edit, write) are always active — never pass them to load_tools",
			"Tool loading is additive across turns — never reload tools that have already been loaded",
		],
		parameters: Type.Object({
			tools: Type.Array(Type.String(), {
				description: `Tool names to load (1-${LOAD_TOOLS_MAX} per call), exactly as listed in the catalog.`,
				minItems: 1,
				maxItems: LOAD_TOOLS_MAX,
			}),
		}),
		execute: async (_id, params) => {
			const l = getLang();
			const asked = (params as { tools?: unknown }).tools;
			const names = Array.isArray(asked)
				? [
						...new Set(
							asked
								.filter((n): n is string => typeof n === "string")
								.map((n) => n.trim())
								.filter(Boolean),
						),
					]
				: [];
			if (names.length === 0) {
				return text(pick(l, "没有给出要加载的工具名。", "No tool names given.", "loadtools.names.empty"), {
					loaded: [],
					rejected: [],
				});
			}
			const { loaded, rejected } = host.load(names.slice(0, LOAD_TOOLS_MAX));
			const lines: string[] = [];
			if (loaded.length > 0) {
				lines.push(
					pick(
						l,
						`已加载 ${loaded.length} 个工具（完整参数 schema 已附上，本对话后续轮次都可用）：`,
						`Loaded ${loaded.length} tool(s) — their full parameter schema is now attached for the rest of this conversation:`,
						"loadtools.loaded",
						{ count: loaded.length },
					),
				);
				for (const t of loaded) {
					const d = describe(t);
					lines.push(`- ${t.name}${d ? `: ${d}` : ""}`);
					// guidelines 不进系统提示词（会随加载变化、打坏前缀缓存），在此随回执交付。
					for (const g of t.guidelines ?? []) {
						const rule = g.trim();
						if (rule) lines.push(`  - ${rule}`);
					}
				}
			}
			for (const r of rejected) {
				lines.push(
					pick(l, `- ${r.name}: ${r.reason}`, `- ${r.name}: ${r.reason}`, "loadtools.rejected", {
						name: r.name,
						reason: r.reason,
					}),
				);
			}
			if (loaded.length === 0 && rejected.length === 0) {
				const catalog = host.listLoadable();
				lines.push(pick(l, "没有可加载的工具了。当前可加载：", "No tools left to load. Available:", "loadtools.none"));
				lines.push(...catalog.map((t) => `- ${t.name}`));
			}
			return text(lines.join("\n"), { loaded: loaded.map((t) => t.name), rejected });
		},
	});
}
