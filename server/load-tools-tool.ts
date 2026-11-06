import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { LOAD_TOOLS_TOOL_NAME } from "./tool-manager.js";

export interface LoadableToolInfo {
	name: string;
	summary?: string;
	description?: string;
	guidelines?: string[];
}

export interface LoadToolsHost {
	listLoadable(): LoadableToolInfo[];
	listLoaded(): string[];
	load(names: string[]): { loaded: LoadableToolInfo[]; rejected: { name: string; reason: string }[] };
}

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
