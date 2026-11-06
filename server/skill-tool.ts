import { statSync, readFileSync } from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { SKILL_TOOL_NAME } from "./tool-manager.js";
import { decodeText } from "./text-sniff.js";

export interface SkillCatalogEntry {
	name: string;
	description: string;
	filePath: string;
	source?: string;
	scope?: string;
}

export interface SkillToolHost {
	listSkills(): SkillCatalogEntry[];
	maxFileBytes?(): number | undefined;
}

export const SKILL_TOOL_FILE_CAP = 8192;

function effectiveFileCap(host: SkillToolHost): number {
	const raw = host.maxFileBytes?.();
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	return SKILL_TOOL_FILE_CAP;
}

export function findSkill(skills: SkillCatalogEntry[], name: string): SkillCatalogEntry | undefined {
	const n = name.trim();
	if (!n) return undefined;
	return skills.find((s) => s.name === n);
}

export function suggestSkills(skills: SkillCatalogEntry[], name: string): SkillCatalogEntry[] {
	const q = name.trim().toLowerCase();
	if (!q) return skills;
	return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}

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
			if (!found) {
				const sug = suggestSkills(skills, name).slice(0, 10);
				const head = pick(L, `没有名为 ${name} 的技能。`, `No skill named ${name}.`, "skill.not.found", { name });
				const sugText = sug.length > 0 ? `\n${formatSkillCatalog(sug, L)}` : `\n${formatSkillCatalog(skills, L)}`;
				return text(`${head}${sugText}`, { name, count: skills.length });
			}
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
