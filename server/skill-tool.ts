// ---------------------------------------------------------------------------
// skill-tool.ts — 让 AI 按名取技能全文（名录 + skill 工具）
// ---------------------------------------------------------------------------
// 背景：{{skills}} 默认只渲染名录（name/description/location），引导语原来让
// 模型“用 read 工具加载技能文件”——模型要自己拼 location 路径调 read，权限大
// 且容易猜错路径。本工具提供专用通道：skill({name}) 精确命中，读文件包成与
// SDK 一致的 `<skill name location>` 块（前端 parseSkillBlock 直接认，渲染折叠
// 卡片）；不给 name 则返回名录 + 用法，找错名则给纠错列表。
//
// 约束（第 1 条定稿，不破坏现有体系）：
//   - 名录渲染不动；skillsFullText 名单注入不动；/skill:name 手势不动；
//   - 正文每次重读（不缓存），单文件 8KB 封顶（与 fillSkillContents 同口径）；
//   - 禁用集由 host 在调用时过滤（与 skillsOverride 主会话语义一致），工具侧
//     查不到被禁用的技能；
//   - 与 SDK 同名工具撞名时 customTools 按 name 覆盖（bash 本体是先例）。
//
// 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯英文；per-call
// 返回文本按 lang 取 pick(lang, zh, en, key)，缺表回落英文内联。
// ---------------------------------------------------------------------------

import { statSync, readFileSync } from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { SKILL_TOOL_NAME } from "./tool-manager.js";
import { decodeText } from "./text-sniff.js";

/** 技能名录行（agent-service 的 skillToolHost 从会话 loader 实时取）。 */
export interface SkillCatalogEntry {
	name: string;
	description: string;
	filePath: string;
	source?: string;
	scope?: string;
}

/** 由 ClientSession 实现的数据宿主（已按 disabledSkills 过滤）。 */
export interface SkillToolHost {
	listSkills(): SkillCatalogEntry[];
	/** 单文件正文上限（字节）；缺省用 SKILL_TOOL_FILE_CAP。每次调用实时读，便于跟随设置。 */
	maxFileBytes?(): number | undefined;
}

/** 单文件正文上限的出厂默认（= 设置项 skillsMaxFileBytes 的默认值，8KB）。 */
export const SKILL_TOOL_FILE_CAP = 8192;

/** 实际生效的单文件上限：非负整数，非法/未设置回退出厂默认。0 = 不设单文件上限。 */
function effectiveFileCap(host: SkillToolHost): number {
	const raw = host.maxFileBytes?.();
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	return SKILL_TOOL_FILE_CAP;
}

/** 精确名匹配（大小写敏感，与 skillsFullText 名单语义一致）。 */
export function findSkill(skills: SkillCatalogEntry[], name: string): SkillCatalogEntry | undefined {
	const n = name.trim();
	if (!n) return undefined;
	return skills.find((s) => s.name === n);
}

/** 大小写不敏感子串纠错（空 query 全匹配，调用方截行数）。 */
export function suggestSkills(skills: SkillCatalogEntry[], name: string): SkillCatalogEntry[] {
	const q = name.trim().toLowerCase();
	if (!q) return skills;
	return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}

/** 名录文本（一行一名 + 一句话描述，无技能时给空目录句）。 */
export function formatSkillCatalog(skills: SkillCatalogEntry[], lang: ServerLang): string {
	if (skills.length === 0) {
		return pick(lang, "当前没有可用技能。", "No skills are currently available.", "skill.catalog.empty");
	}
	const head = pick(
		lang,
		`可用技能（${skills.length}）：`,
		`Available skills (${skills.length}):`,
		"skill.catalog.title",
		{ count: skills.length },
	);
	const lines = skills.map((s) => {
		const tag = s.source ? ` [${s.source.toUpperCase()}]` : "";
		return `- ${s.name}${tag}${s.description.trim() ? ` — ${s.description.trim()}` : ""}`;
	});
	return `${head}\n${lines.join("\n")}`;
}

/** 生成多智能体技能整合分布统计报告文本 */
export function formatSkillSourcesReport(skills: SkillCatalogEntry[], lang: ServerLang): string {
	const counts: Record<string, number> = {};
	for (const s of skills) {
		const src = (s.source || "custom").toLowerCase();
		counts[src] = (counts[src] || 0) + 1;
	}
	const isZh = lang === "zh";
	const lines: string[] = [];
	lines.push(
		isZh
			? `【跨智能体技能整合报告】共整合 ${skills.length} 个可用技能：`
			: `[Universal Skills Report] Total ${skills.length} available skills:`,
	);
	for (const [src, num] of Object.entries(counts)) {
		lines.push(`  - ${src.toUpperCase()}: ${num}`);
	}
	lines.push("");
	lines.push(formatSkillCatalog(skills, lang));
	return lines.join("\n");
}

/** 技能全文块（与 SDK 的 /skill:name 展开格式一致，前端按 skill 卡片渲染）。 */
export function renderSkillContent(name: string, location: string, body: string): string {
	return `<skill name="${name}" location="${location}">\n${body.trim()}\n</skill>`;
}

export function makeSkillTool(host: SkillToolHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: SKILL_TOOL_NAME,
		label: "Load a skill",
		description:
			"Load a skill's full text by its exact name (see the <available_skills> catalog). " +
			"Prefer this over reading the skill file with read — no path guessing.",
		promptSnippet: "use a skill from <available_skills> by name",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({
					description: "Exact skill name from the catalog. Omit to list the current catalog.",
				}),
			),
			action: Type.Optional(
				Type.String({
					description:
						"Action: omit or 'read' to load skill text; 'list' to show catalog; 'report' to view multi-agent sources.",
				}),
			),
		}),
		execute: async (_id, p) => {
			let skills: SkillCatalogEntry[] = [];
			try {
				skills = host.listSkills();
			} catch {
				skills = [];
			}
			const L = getLang();
			const action = typeof p.action === "string" ? p.action.trim().toLowerCase() : "";
			const name = typeof p.name === "string" ? p.name.trim() : "";

			if (action === "report") {
				return text(formatSkillSourcesReport(skills, L), { count: skills.length });
			}

			// 无名或请求列表 → 名录 + 用法。
			if (!name || action === "list") {
				const hint = pick(
					L,
					"用 skill({name}) 按名取全文。",
					"Use skill({name}) to load the full text by name.",
					"skill.catalog.hint",
				);
				return text(`${formatSkillCatalog(skills, L)}\n${hint}`, { count: skills.length });
			}
			const found = findSkill(skills, name);
			// 找错名 → 纠错列表（不抛错，报名录）。
			if (!found) {
				const sug = suggestSkills(skills, name).slice(0, 10);
				const head = pick(L, `没有名为 ${name} 的技能。`, `No skill named ${name}.`, "skill.not.found", { name });
				const sugText = sug.length > 0 ? `\n${formatSkillCatalog(sug, L)}` : `\n${formatSkillCatalog(skills, L)}`;
				return text(`${head}${sugText}`, { name, count: skills.length });
			}
			// 命中 → 最好努力读正文（每次重读，不缓存；失败/超限给可读错）。
			if (!found.filePath) {
				return text(
					pick(
						L,
						`技能 ${name} 没有关联文件路径，取不到全文。`,
						`Skill ${name} has no file path; full text unavailable.`,
						"skill.no.filepath",
						{ name },
					),
				);
			}
			try {
				const st = statSync(found.filePath);
				const cap = effectiveFileCap(host);
				// 0 = 不设单文件上限（设置项显式打开）；否则超限回落可读错误，不截断正文。
				const kb = Math.max(1, Math.round(cap / 1024));
				if (!st.isFile() || st.size <= 0 || (cap > 0 && st.size > cap)) {
					return text(
						pick(
							L,
							`技能 ${name} 的文件不可读（不存在/超 ${kb}KB 上限）。`,
							`Skill ${name} file unreadable (missing or over the ${kb}KB cap).`,
							"skill.file.unreadable",
							{ name, kb },
						),
					);
				}
				const body = decodeText(readFileSync(found.filePath).subarray(0, st.size)).trim();
				if (!body) {
					return text(
						pick(L, `技能 ${name} 的文件是空的。`, `Skill ${name} file is empty.`, "skill.file.empty", { name }),
					);
				}
				return text(renderSkillContent(found.name, found.filePath, body), {
					name: found.name,
					location: found.filePath,
				});
			} catch {
				return text(
					pick(
						L,
						`技能 ${name} 的文件读取失败（可能已被删除或移走）。`,
						`Failed to read skill ${name} file (may have been deleted or moved).`,
						"skill.file.failed",
						{ name },
					),
				);
			}
		},
	});
}
